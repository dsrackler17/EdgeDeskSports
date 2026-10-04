/* ===========================================================================
   EDGEDESK PORTFOLIO — the calculation engine.
   docs/portfolio-architecture.md

   One question: across every sportsbook and every prediction market a reader
   uses, are they up or down, and by how much? This file is the arithmetic and
   the vocabulary, and only that. It never fetches, never stores and never
   reads a clock unless one is passed in.

   EXACT MONEY, NO FLOATING POINT
     Every amount is an exact decimal held as a BigInt and a scale. Inputs are
     strings (PostgREST is asked for numeric::text) or numbers; outputs are
     canonical strings ("90.91", "-61", "0.61"). The one division rule —
     divRound(), half away from zero, computed by integer division — is the
     same algorithm as public.portfolio_div_round() in supabase/portfolio.sql,
     and tools/portfolio/portfolio_sql.test.js holds derive() here and the
     database trigger in parity, figure for figure.

   TWO INSTRUMENTS, TWO SETS OF RULES
     wager      (platform_type SPORTSBOOK) stake × price, settled by status:
                WON pays stake + profit, LOST pays 0, PUSH and VOID return the
                stake, CASHED_OUT and SETTLED pay what the book reported.
                Profit is never payout: $100 at -110 that wins pays $190.91
                and PROFITS $90.91.
     contract   (platform_type PREDICTION_MARKET) a quantity of contracts that
                pay $1 each if the side held resolves true. Rebuilt from its
                fills with the average-cost method; partial sells realize P&L
                as they happen; fees are an expense when charged. Never run
                through an odds formula.

   WHAT COUNTS WHERE (stated once, used everywhere)
     total P&L      the sum of profit_loss over SETTLED positions. An open
                    position's partial exits show on that position (realized
                    so far) and join the total when it closes.
     ROI            settled P&L / settled capital (stake or contract cost).
     capital        stake or contract cost of every position placed.
     open exposure  what is still at risk at cost: an open wager's stake, an
                    open contract position's remaining cost basis.
     win rate       wins / (wins + losses); pushes, voids and cash-outs are
                    not in the denominator.
     average odds   the stake-weighted mean DECIMAL price, printed as American
                    (lib/edgedesk_pnl.js uses the same convention).

   Browser: window.EDPortfolio.   Node: require('./edgedesk_portfolio.js').
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EDPortfolio = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var VERSION = 'portfolio_calc_v1';

  /* ═══ 1. EXACT DECIMALS ═══════════════════════════════════════════════ */
  var B0 = BigInt(0), B1 = BigInt(1), B2 = BigInt(2), B10 = BigInt(10);
  var NUM_RE = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;
  function pow10(k) { var r = B1; for (var i = 0; i < k; i++) r *= B10; return r; }
  function trim(d) {
    while (d.s > 0 && d.n % B10 === B0) { d.n /= B10; d.s--; }
    return d;
  }
  /* any number-like input → {n, s} (value n / 10^s), or null */
  function P(x) {
    if (x == null) return null;
    if (typeof x === 'object' && typeof x.n === 'bigint') return x;
    if (typeof x === 'number' && !isFinite(x)) return null;
    if (typeof x === 'bigint') return { n: x, s: 0 };
    var s = String(x).trim();
    if (s === '') return null;
    var m = NUM_RE.exec(s);
    if (!m || ((m[2] || '') === '' && (m[3] || '') === '')) return null;
    var frac = m[3] || '', exp = m[4] ? parseInt(m[4], 10) : 0;
    if (Math.abs(exp) > 400) return null;
    var n = BigInt(((m[2] || '') + frac) || '0'), scale = frac.length - exp;
    if (scale < 0) { n = n * pow10(-scale); scale = 0; }
    if (m[1] === '-') n = -n;
    return trim({ n: n, s: scale });
  }
  function up(d, s) { return d.s === s ? d.n : d.n * pow10(s - d.s); }
  function add(a, b) { var s = Math.max(a.s, b.s); return trim({ n: up(a, s) + up(b, s), s: s }); }
  function sub(a, b) { var s = Math.max(a.s, b.s); return trim({ n: up(a, s) - up(b, s), s: s }); }
  function mul(a, b) { return trim({ n: a.n * b.n, s: a.s + b.s }); }
  function neg(a) { return { n: -a.n, s: a.s }; }
  function cmp(a, b) { var s = Math.max(a.s, b.s), x = up(a, s), y = up(b, s); return x < y ? -1 : x > y ? 1 : 0; }
  function sgn(a) { return a.n > B0 ? 1 : a.n < B0 ? -1 : 0; }
  function abs(a) { return a.n < B0 ? neg(a) : a; }
  /* a / b, rounded half away from zero at `scale` decimals, exactly */
  function divRound(a, b, scale) {
    if (b.n === B0) return null;
    var num = a.n * pow10(b.s + scale), den = b.n * pow10(a.s);
    var q = num / den, r = num - q * den;
    var ar = r < B0 ? -r : r, ad = den < B0 ? -den : den;
    if (B2 * ar >= ad) q += ((num < B0) !== (den < B0)) ? -B1 : B1;
    return trim({ n: q, s: scale });
  }
  function S(d) {
    if (d == null) return null;
    var neg_ = d.n < B0, t = (neg_ ? -d.n : d.n).toString();
    if (d.s > 0) {
      while (t.length <= d.s) t = '0' + t;
      t = t.slice(0, t.length - d.s) + '.' + t.slice(t.length - d.s);
    }
    return (neg_ && d.n !== B0 ? '-' : '') + t;
  }
  function fixed(d, k) {
    var r = divRound(d, { n: B1, s: 0 }, k), t = S(r), i = t.indexOf('.');
    if (k === 0) return t;
    if (i < 0) return t + '.' + new Array(k + 1).join('0');
    return t + new Array(k - (t.length - i - 1) + 1).join('0');
  }
  var ZERO = { n: B0, s: 0 }, ONE = { n: B1, s: 0 }, HUNDRED = { n: BigInt(100), s: 0 };
  function sum(list) { var t = ZERO; for (var i = 0; i < list.length; i++) if (list[i]) t = add(t, list[i]); return t; }

  /* the public face of the decimal kit: strings in, strings out */
  var dec = {
    valid: function (x) { return P(x) != null; },
    add: function (a, b) { return S(add(P(a), P(b))); },
    sub: function (a, b) { return S(sub(P(a), P(b))); },
    mul: function (a, b) { return S(mul(P(a), P(b))); },
    divRound: function (a, b, k) { return S(divRound(P(a), P(b), k)); },
    round: function (a, k) { return S(divRound(P(a), ONE, k)); },
    cmp: function (a, b) { return cmp(P(a), P(b)); },
    sign: function (a) { return sgn(P(a)); },
    fixed: function (a, k) { return fixed(P(a), k); },
    str: function (a) { return S(P(a)); },
    sum: function (list) { return S(sum((list || []).map(P))); }
  };

  /* ═══ 2. VOCABULARY ═══════════════════════════════════════════════════ */
  var PLATFORM_TYPES = ['SPORTSBOOK', 'PREDICTION_MARKET'];
  var POSITION_TYPES = ['MONEYLINE', 'SPREAD', 'TOTAL', 'PLAYER_PROP', 'PARLAY', 'SAME_GAME_PARLAY', 'FUTURE',
    'EVENT_CONTRACT', 'PREDICTION_MARKET', 'OTHER'];
  var POSITION_TYPE_LABEL = { MONEYLINE: 'Moneyline', SPREAD: 'Spread', TOTAL: 'Total', PLAYER_PROP: 'Player prop',
    PARLAY: 'Parlay', SAME_GAME_PARLAY: 'Same-game parlay', FUTURE: 'Future', EVENT_CONTRACT: 'Event contract',
    PREDICTION_MARKET: 'Prediction market', OTHER: 'Other' };
  var WAGER_STATUSES = ['OPEN', 'WON', 'LOST', 'PUSH', 'VOID', 'CASHED_OUT', 'SETTLED'];
  var CONTRACT_STATUSES = ['OPEN', 'SETTLED', 'VOID'];
  var RESULTS = ['WIN', 'LOSS', 'PUSH', 'VOID', 'CASHOUT'];
  var SOURCES = ['MANUAL', 'CSV', 'SYNC', 'EDGEDESK'];
  var CONNECTION_TYPES = ['MANUAL', 'CSV', 'API', 'OAUTH', 'AGGREGATOR'];
  var ACCOUNT_STATUSES = ['CONNECTED', 'IMPORT_ONLY', 'MANUAL', 'SYNCING', 'ACTION_REQUIRED', 'DISCONNECTED', 'ERROR'];
  var TRANSACTION_TYPES = ['BET', 'BUY', 'SELL', 'FILL', 'CASHOUT', 'SETTLEMENT', 'VOID', 'REFUND', 'DEPOSIT', 'WITHDRAWAL', 'FEE', 'ADJUSTMENT'];
  var STAKE_TYPES = ['CASH', 'BONUS'];
  var EDGE_SOURCES = ['EDGEDESK', 'SELF', 'OTHER'];
  var EDGE_REF_TYPES = ['stake_recommendation', 'research_journal', 'card_opportunity', 'user_bet'];
  /* an account's status, in words. "Connected" is only ever printed for a
     real API / OAuth / aggregator connection: the database refuses it on a
     manual or CSV account, and this map never invents it either. */
  var ACCOUNT_STATUS_LABEL = { CONNECTED: 'Connected', IMPORT_ONLY: 'CSV import', MANUAL: 'Manual tracking',
    SYNCING: 'Syncing', ACTION_REQUIRED: 'Action required', DISCONNECTED: 'Disconnected', ERROR: 'Error' };

  /* The platforms a reader can pick. Sportsbook keys are EdgeDesk's existing
     book keys (lib/edgedesk_personal.js BOOKS, the odds capture's BOOK_TIER),
     so a position can later be joined to the prices EdgeDesk captured.
     autoSync is the truth today: nothing syncs automatically yet.
     docs/platform-support.md is the long form of this table. */
  var PLATFORMS = [
    { key: 'draftkings', label: 'DraftKings', type: 'SPORTSBOOK' },
    { key: 'fanduel', label: 'FanDuel', type: 'SPORTSBOOK' },
    { key: 'betmgm', label: 'BetMGM', type: 'SPORTSBOOK' },
    { key: 'williamhill_us', label: 'Caesars', type: 'SPORTSBOOK' },
    { key: 'bet365', label: 'bet365', type: 'SPORTSBOOK' },
    { key: 'betrivers', label: 'BetRivers', type: 'SPORTSBOOK' },
    { key: 'espnbet', label: 'theScore Bet (ESPN BET)', type: 'SPORTSBOOK' },
    { key: 'fanatics', label: 'Fanatics', type: 'SPORTSBOOK' },
    { key: 'hardrockbet', label: 'Hard Rock Bet', type: 'SPORTSBOOK' },
    { key: 'circasports', label: 'Circa Sports', type: 'SPORTSBOOK' },
    { key: 'superbook', label: 'SuperBook', type: 'SPORTSBOOK' },
    { key: 'pinnacle', label: 'Pinnacle', type: 'SPORTSBOOK' },
    { key: 'novig', label: 'Novig', type: 'SPORTSBOOK' },
    { key: 'prophetx', label: 'ProphetX', type: 'SPORTSBOOK' },
    { key: 'kalshi', label: 'Kalshi', type: 'PREDICTION_MARKET' },
    { key: 'polymarket', label: 'Polymarket', type: 'PREDICTION_MARKET' },
    { key: 'draftkings_predictions', label: 'DraftKings Predictions', type: 'PREDICTION_MARKET' },
    { key: 'fanduel_predicts', label: 'FanDuel Predicts', type: 'PREDICTION_MARKET' }
  ].map(function (p) { p.methods = ['MANUAL', 'CSV']; p.autoSync = false; return p; });
  var PLATFORM_BY_KEY = {};
  PLATFORMS.forEach(function (p) { PLATFORM_BY_KEY[p.key] = p; });
  var PLATFORM_KEY_RE = /^[a-z0-9][a-z0-9_]{1,47}$/;
  /* "Other" platforms: a stable key from the reader's own label */
  function customPlatformKey(label) {
    var slug = String(label == null ? '' : label).normalize('NFKD').replace(/[^\x20-\x7e]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    return slug ? 'custom_' + slug : null;
  }
  function platformLabel(key, fallback) {
    var p = PLATFORM_BY_KEY[key];
    return p ? p.label : (fallback || String(key || '').replace(/^custom_/, '').replace(/_/g, ' '));
  }
  /* free text from a CSV ("DK", "Caesars Sportsbook", "kalshi.com") → a key */
  var PLATFORM_ALIASES = [
    [/^(dk|draft ?kings?)( sportsbook)?$/, 'draftkings'], [/^(fd|fan ?duel)( sportsbook)?$/, 'fanduel'],
    [/^(mgm|bet ?mgm)$/, 'betmgm'], [/^(czr|caesars|caesars sportsbook|william ?hill)$/, 'williamhill_us'],
    [/^bet ?365$/, 'bet365'], [/^bet ?rivers$/, 'betrivers'], [/^(espn ?bet|the ?score ?bet|thescore)$/, 'espnbet'],
    [/^fanatics( sportsbook)?$/, 'fanatics'], [/^hard ?rock( bet)?$/, 'hardrockbet'], [/^circa( sports)?$/, 'circasports'],
    [/^(super ?book|westgate)$/, 'superbook'], [/^pinnacle$/, 'pinnacle'], [/^novig$/, 'novig'], [/^prophet ?x$/, 'prophetx'],
    [/^kalshi(\.com)?$/, 'kalshi'], [/^poly ?market(\.com)?$/, 'polymarket'],
    [/^(dk|draft ?kings?) ?predictions?$/, 'draftkings_predictions'], [/^(fd|fan ?duel) ?predicts?$/, 'fanduel_predicts']
  ];
  function resolvePlatform(text) {
    var t = String(text == null ? '' : text).trim().toLowerCase().replace(/\s+/g, ' ');
    if (!t) return null;
    if (PLATFORM_BY_KEY[t]) return PLATFORM_BY_KEY[t].key;
    for (var i = 0; i < PLATFORM_ALIASES.length; i++) if (PLATFORM_ALIASES[i][0].test(t)) return PLATFORM_ALIASES[i][1];
    for (var j = 0; j < PLATFORMS.length; j++) if (PLATFORMS[j].label.toLowerCase() === t) return PLATFORMS[j].key;
    return null;
  }

  /* ═══ 3. A WAGER ══════════════════════════════════════════════════════ */
  function intAmerican(x) {
    var d = P(x);
    if (!d || d.s !== 0) return null;
    var v = Number(d.n);
    return (v <= -100 || v >= 100) && Math.abs(v) <= 1000000 ? v : null;
  }
  function americanToDecimalD(a) {
    if (a == null) return null;
    return a >= 100 ? add(ONE, divRound(P(a), HUNDRED, 6)) : add(ONE, divRound(HUNDRED, P(Math.abs(a)), 6));
  }
  function americanToDecimal(a) { return S(americanToDecimalD(intAmerican(a))); }
  /* for display only: the American price nearest a decimal one */
  function decimalToAmerican(x) {
    var d = P(x);
    if (!d || cmp(d, ONE) <= 0) return null;
    var e = sub(d, ONE);
    var v = cmp(d, P(2)) >= 0 ? divRound(mul(e, HUNDRED), ONE, 0) : neg(divRound(HUNDRED, e, 0));
    return Number(S(v));
  }
  function wagerProfitD(stake, american, decimal) {
    if (!stake) return null;
    if (american != null && american >= 100) return divRound(mul(stake, P(american)), HUNDRED, 2);
    if (american != null && american <= -100) return divRound(mul(stake, HUNDRED), P(Math.abs(american)), 2);
    if (decimal && cmp(decimal, ONE) > 0) return divRound(mul(stake, sub(decimal, ONE)), ONE, 2);
    return null;
  }
  /* profit on a winning wager, to the cent */
  function wagerProfit(stake, american, decimal) {
    return S(wagerProfitD(P(stake), intAmerican(american), P(decimal)));
  }
  /* A parlay from its legs: the price is the product of the legs' decimal
     prices, a pushed or voided leg drops out (the book re-prices without it),
     one lost leg loses the ticket. Decimal rounded to 6 places, as the
     database stores a decimal price. */
  function parlay(legs) {
    var price = ONE, live = 0, settled = 0, lost = false, open = false;
    (legs || []).forEach(function (l) {
      var r = String(l.result || 'OPEN').toUpperCase();
      var d = l.odds_american != null && l.odds_american !== '' ? americanToDecimalD(intAmerican(l.odds_american)) : P(l.odds_decimal);
      if (r === 'LOST') { lost = true; settled++; return; }
      if (r === 'PUSH' || r === 'VOID') { settled++; return; }
      if (!d || cmp(d, ONE) <= 0) { price = null; return; }
      if (price) price = mul(price, d);
      live++;
      if (r === 'WON') settled++; else open = true;
    });
    if (!legs || !legs.length || price === null) return null;
    var status = lost ? 'LOST' : open ? 'OPEN' : live === 0 ? 'PUSH' : 'WON';
    var decimal = live ? divRound(price, ONE, 6) : null;
    return { status: status, odds_decimal: S(decimal), odds_american: decimal ? decimalToAmerican(decimal) : null, legs_live: live, legs_settled: settled };
  }

  /* ═══ 4. derive() — the database trigger, in JavaScript ═══════════════ */
  var DERIVED = ['odds_decimal', 'potential_profit', 'potential_payout', 'cost_basis', 'open_cost_basis', 'gross_payout',
    'profit_loss', 'realized_profit_loss', 'unrealized_profit_loss', 'current_value', 'contracts', 'contracts_bought',
    'contracts_sold', 'average_entry_price', 'average_exit_price', 'sell_proceeds', 'fees', 'status', 'result'];
  function isBuy(t) { var ty = String(t.transaction_type || '').toUpperCase(); return ty === 'BUY' || (ty === 'FILL' && String(t.side || '').toUpperCase() === 'BUY'); }
  function isSell(t) { var ty = String(t.transaction_type || '').toUpperCase(); return ty === 'SELL' || (ty === 'FILL' && String(t.side || '').toUpperCase() === 'SELL'); }
  function signResult(pl) { var g = sgn(pl); return g > 0 ? 'WIN' : g < 0 ? 'LOSS' : 'PUSH'; }
  function upperTrim(x) { return x == null ? null : (String(x).trim().toUpperCase() || null); }

  /* p: the position's inputs; fills: its transactions (contract positions).
     Returns every derived column as the database would store it. */
  function derive(p, fills) {
    var o = {}, type = upperTrim(p.platform_type), status = upperTrim(p.status) || 'OPEN', fees = P(p.fees) || ZERO;
    DERIVED.forEach(function (k) { o[k] = null; });
    if (type === 'SPORTSBOOK') {
      var stake = P(p.stake), am = intAmerican(p.odds_american);
      var dc = am != null ? americanToDecimalD(am) : P(p.odds_decimal), rp = P(p.reported_payout);
      var pp = wagerProfitD(stake, am, dc);
      /* a bonus bet risks no cash and pays only its winnings */
      var bonus = upperTrim(p.stake_type) === 'BONUS', basis = bonus ? (stake ? ZERO : null) : stake;
      o.odds_decimal = S(dc); o.potential_profit = S(pp);
      o.potential_payout = stake && pp ? S(bonus ? pp : add(stake, pp)) : null;
      o.cost_basis = S(basis); o.fees = S(fees); o.status = status;
      if (status === 'OPEN') { o.open_cost_basis = S(basis); return o; }
      var gross = status === 'WON' ? (rp || (stake && pp ? (bonus ? pp : add(stake, pp)) : null))
        : status === 'LOST' ? (rp || ZERO)
        : (status === 'PUSH' || status === 'VOID') ? (rp || basis) : rp;
      if (!gross || !stake) return o;
      var pl = sub(sub(gross, basis), fees);
      o.gross_payout = S(gross); o.profit_loss = S(pl); o.realized_profit_loss = S(pl); o.open_cost_basis = '0';
      o.result = { WON: 'WIN', LOST: 'LOSS', PUSH: 'PUSH', VOID: 'VOID', CASHED_OUT: 'CASHOUT' }[status] || signResult(pl);
      return o;
    }
    /* a contract position, rebuilt from its fills */
    var b = ZERO, bc = ZERO, s = ZERO, sp = ZERO, f = ZERO;
    (fills || []).forEach(function (t) {
      var q = P(t.quantity), pr = P(t.price);
      if (isBuy(t) && q && pr) { b = add(b, q); bc = add(bc, mul(q, pr)); }
      if (isSell(t) && q && pr) { s = add(s, q); sp = add(sp, mul(q, pr)); }
      f = add(f, P(t.fee) || ZERO);
    });
    var held = sub(b, s), hasBuys = sgn(b) > 0;
    var openCost = hasBuys ? divRound(mul(held, bc), b, 6) : ZERO;
    var resolution = p.resolution == null || String(p.resolution).trim() === '' ? null : String(p.resolution).trim();
    o.contracts_bought = S(b); o.contracts_sold = S(s); o.contracts = S(held);
    o.sell_proceeds = S(sp); o.fees = S(f); o.cost_basis = S(bc);
    o.average_entry_price = hasBuys ? S(divRound(bc, b, 6)) : null;
    o.average_exit_price = sgn(s) > 0 ? S(divRound(sp, s, 6)) : null;
    o.status = resolution && resolution.toUpperCase() === 'VOID' ? 'VOID'
      : resolution ? 'SETTLED' : (hasBuys && sgn(held) <= 0) ? 'SETTLED' : 'OPEN';
    if (o.status === 'OPEN') {
      var cp = P(p.current_price);
      o.open_cost_basis = S(openCost);
      o.realized_profit_loss = S(sub(sub(sp, sub(bc, openCost)), f));
      if (cp) { var cv = mul(held, cp); o.current_value = S(cv); o.unrealized_profit_loss = S(sub(cv, openCost)); }
      o.potential_payout = S(held); o.potential_profit = S(sub(held, openCost));
      return o;
    }
    /* the price each held contract settles at: the stated one, else $1 when
       the resolution names the side held and $0 when it names another; an
       exit with no resolution has nothing left to settle */
    var settle = P(p.settlement_price);
    if (!settle && o.status !== 'VOID' && resolution) {
      settle = resolution.toUpperCase() === String(p.side == null ? '' : p.side).trim().toUpperCase() ? ONE : ZERO;
    }
    var settleAmt = P(p.reported_payout) || (sgn(held) <= 0 ? ZERO : settle ? mul(held, settle) : openCost);
    var grossC = add(sp, settleAmt), plC = sub(sub(grossC, bc), f);
    o.gross_payout = S(grossC); o.profit_loss = S(plC); o.realized_profit_loss = S(plC); o.open_cost_basis = '0';
    o.result = o.status === 'VOID' ? 'VOID' : signResult(plC);
    return o;
  }

  /* ═══ 5. VALIDATION — one rule set for forms, imports and connectors ══ */
  function issue(level, code, message) { return { level: level, code: code, message: message }; }
  function validateWager(n) {
    var out = [];
    if (!n.platform || !PLATFORM_KEY_RE.test(n.platform)) out.push(issue('error', 'BAD_PLATFORM', 'Choose the sportsbook.'));
    if (!clean(n.event_name)) out.push(issue('error', 'MISSING_EVENT_NAME', 'Name the event.'));
    if (!clean(n.market_name)) out.push(issue('error', 'MISSING_MARKET_NAME', 'Name the market.'));
    if (!clean(n.selection)) out.push(issue('error', 'MISSING_SELECTION', 'Name the selection.'));
    var st = P(n.stake);
    if (!st || sgn(st) <= 0 || st.s > 2) out.push(issue('error', 'BAD_STAKE', 'The stake must be a positive amount in dollars and cents.'));
    var am = n.odds_american != null && n.odds_american !== '' ? intAmerican(n.odds_american) : null;
    if (n.odds_american != null && n.odds_american !== '' && am == null) out.push(issue('error', 'BAD_ODDS', 'American odds are -100 or lower, or +100 or higher.'));
    var dc = P(n.odds_decimal);
    if (am == null && (!dc || cmp(dc, ONE) <= 0)) out.push(issue('error', 'BAD_ODDS', 'Enter the odds.'));
    if (!validTime(n.placed_at)) out.push(issue('error', 'BAD_PLACED_AT', 'Enter when the bet was placed.'));
    var status = upperTrim(n.status) || 'OPEN';
    if (WAGER_STATUSES.indexOf(status) < 0) out.push(issue('error', 'BAD_STATUS', 'Unknown status.'));
    if ((status === 'CASHED_OUT' || status === 'SETTLED') && !P(n.reported_payout)) out.push(issue('error', 'PAYOUT_NEEDED', 'Enter the amount the book paid.'));
    if (n.reported_payout != null && n.reported_payout !== '' && (!P(n.reported_payout) || sgn(P(n.reported_payout)) < 0)) out.push(issue('error', 'BAD_PAYOUT', 'The payout must be zero or more.'));
    if (n.fees != null && n.fees !== '' && (!P(n.fees) || sgn(P(n.fees)) < 0)) out.push(issue('error', 'BAD_FEES', 'Fees must be zero or more.'));
    if (validTime(n.placed_at) && Date.parse(n.placed_at) > Date.now() + 86400000) out.push(issue('error', 'FUTURE_PLACED_AT', 'A bet cannot be placed in the future.'));
    if (n.settled_at && validTime(n.settled_at) && validTime(n.placed_at) && Date.parse(n.settled_at) < Date.parse(n.placed_at)) out.push(issue('error', 'SETTLED_BEFORE_PLACED', 'It cannot settle before it was placed.'));
    return out;
  }
  function validateFill(n) {
    var out = [];
    if (!n.platform || !PLATFORM_KEY_RE.test(n.platform)) out.push(issue('error', 'BAD_PLATFORM', 'Choose the platform.'));
    if (!clean(n.event_name)) out.push(issue('error', 'MISSING_EVENT_NAME', 'Name the event or question.'));
    if (!clean(n.market_name)) out.push(issue('error', 'MISSING_MARKET_NAME', 'Name the market.'));
    if (!clean(n.side)) out.push(issue('error', 'MISSING_SIDE', 'Choose the side held (YES / NO, or the outcome).'));
    var a = upperTrim(n.action);
    if (a !== 'BUY' && a !== 'SELL') out.push(issue('error', 'BAD_ACTION', 'A trade is a BUY or a SELL.'));
    var q = P(n.quantity);
    if (!q || sgn(q) <= 0 || q.s > 6) out.push(issue('error', 'BAD_QUANTITY', 'Contracts must be a positive number.'));
    var pr = P(n.price);
    if (!pr || sgn(pr) < 0 || cmp(pr, ONE) > 0 || pr.s > 6) out.push(issue('error', 'BAD_PRICE', 'A contract price is between $0.00 and $1.00.'));
    if (n.fee != null && n.fee !== '' && (!P(n.fee) || sgn(P(n.fee)) < 0)) out.push(issue('error', 'BAD_FEES', 'Fees must be zero or more.'));
    if (!validTime(n.executed_at)) out.push(issue('error', 'BAD_EXECUTED_AT', 'Enter when the trade happened.'));
    else if (Date.parse(n.executed_at) > Date.now() + 86400000) out.push(issue('error', 'FUTURE_EXECUTED_AT', 'A trade cannot happen in the future.'));
    ['current_price', 'settlement_price'].forEach(function (k) {
      if (n[k] != null && n[k] !== '') { var v = P(n[k]); if (!v || sgn(v) < 0 || cmp(v, ONE) > 0) out.push(issue('error', 'BAD_' + k.toUpperCase(), 'Prices are between $0.00 and $1.00.')); }
    });
    return out;
  }
  function clean(x) { return x != null && String(x).trim() !== ''; }
  function validTime(x) { return x != null && x !== '' && isFinite(Date.parse(x)); }

  /* ═══ 6. AGGREGATION ══════════════════════════════════════════════════ */
  function isSettled(p) { return upperTrim(p.status) !== 'OPEN'; }
  function ms(x) { var t = Date.parse(x); return isFinite(t) ? t : null; }
  function inRange(t, from, to) { return t != null && (from == null || t >= from) && (to == null || t < to); }
  function emptyStats() {
    return { pnl: ZERO, settledCapital: ZERO, capital: ZERO, openExposure: ZERO, unrealized: ZERO, openRealized: ZERO,
      fees: ZERO, settled: 0, open: 0, openMarked: 0, positions: 0,
      record: { won: 0, lost: 0, push: 0, void: 0, cashout: 0 } };
  }
  function addTo(st, p, from, to) {
    var settled = isSettled(p), tSettled = ms(p.settled_at), tPlaced = ms(p.placed_at);
    if (inRange(tPlaced, from, to)) { st.positions++; st.capital = add(st.capital, P(p.cost_basis) || ZERO); }
    if (settled) {
      if (!inRange(tSettled, from, to)) return;
      var pl = P(p.profit_loss);
      st.settled++;
      if (pl) st.pnl = add(st.pnl, pl);
      st.settledCapital = add(st.settledCapital, P(p.cost_basis) || ZERO);
      st.fees = add(st.fees, P(p.fees) || ZERO);
      var r = upperTrim(p.result);
      if (r === 'WIN') st.record.won++; else if (r === 'LOSS') st.record.lost++; else if (r === 'PUSH') st.record.push++;
      else if (r === 'VOID') st.record.void++; else if (r === 'CASHOUT') st.record.cashout++;
    } else {
      st.open++;
      st.openExposure = add(st.openExposure, P(p.open_cost_basis) || ZERO);
      st.openRealized = add(st.openRealized, P(p.realized_profit_loss) || ZERO);
      var u = P(p.unrealized_profit_loss);
      if (u) { st.unrealized = add(st.unrealized, u); st.openMarked++; }
    }
  }
  function finish(st) {
    var w = st.record.won, l = st.record.lost;
    return {
      pnl: S(st.pnl), settledCapital: S(st.settledCapital), capital: S(st.capital),
      roi: sgn(st.settledCapital) > 0 ? S(divRound(st.pnl, st.settledCapital, 6)) : null,
      openExposure: S(st.openExposure), unrealized: st.openMarked ? S(st.unrealized) : null, openRealized: S(st.openRealized),
      fees: S(st.fees), settled: st.settled, open: st.open, openMarked: st.openMarked, positions: st.positions,
      record: st.record, winRate: (w + l) > 0 ? S(divRound(P(w), P(w + l), 6)) : null
    };
  }
  function group(list, keyFn, labelFn, from, to) {
    var by = {}, order = [];
    list.forEach(function (p) {
      var k = keyFn(p);
      if (!by[k]) { by[k] = emptyStats(); by[k].key = k; by[k].label = labelFn(p, k); order.push(k); }
      addTo(by[k], p, from, to);
    });
    return order.map(function (k) { var f = finish(by[k]); f.key = k; f.label = by[k].label; return f; })
      .filter(function (g) { return g.settled > 0 || g.open > 0 || g.positions > 0; })
      .sort(function (a, b) { return cmp(P(b.pnl), P(a.pnl)) || a.label.localeCompare(b.label); });
  }
  function extremes(groups) {
    var ranked = groups.filter(function (g) { return g.settled > 0; });
    if (ranked.length < 2) return { best: null, worst: null };
    return { best: ranked[0], worst: ranked[ranked.length - 1] };
  }
  /* The whole book. opts.from / opts.to (ms) bound settled figures by
     settled_at and capital by placed_at; open figures are always now. */
  function summarize(positions, opts) {
    opts = opts || {};
    var list = positions || [], from = opts.from == null ? null : opts.from, to = opts.to == null ? null : opts.to;
    var all = emptyStats();
    list.forEach(function (p) { addTo(all, p, from, to); });
    var out = finish(all);
    var wagers = list.filter(function (p) { return upperTrim(p.platform_type) === 'SPORTSBOOK'; });
    var contracts = list.filter(function (p) { return upperTrim(p.platform_type) === 'PREDICTION_MARKET'; });
    var placed = function (p) { return inRange(ms(p.placed_at), from, to); };
    /* average stake and the stake-weighted mean decimal price, as American */
    var wp = wagers.filter(placed), stakes = ZERO, weighted = ZERO;
    wp.forEach(function (p) {
      var s = P(p.stake), d = P(p.odds_decimal);
      if (s) { stakes = add(stakes, s); if (d) weighted = add(weighted, mul(s, d)); }
    });
    out.averageStake = wp.length ? S(divRound(stakes, P(wp.length), 2)) : null;
    var meanDec = sgn(stakes) > 0 && sgn(weighted) > 0 ? divRound(weighted, stakes, 6) : null;
    out.averageOddsDecimal = S(meanDec);
    out.averageOddsAmerican = meanDec ? decimalToAmerican(meanDec) : null;
    var cp = contracts.filter(placed), qty = ZERO, cost = ZERO;
    cp.forEach(function (p) { qty = add(qty, P(p.contracts_bought) || ZERO); cost = add(cost, P(p.cost_basis) || ZERO); });
    out.averageEntryPrice = sgn(qty) > 0 ? S(divRound(cost, qty, 6)) : null;
    out.byType = {
      SPORTSBOOK: (function () { var s = emptyStats(); wagers.forEach(function (p) { addTo(s, p, from, to); }); return finish(s); }()),
      PREDICTION_MARKET: (function () { var s = emptyStats(); contracts.forEach(function (p) { addTo(s, p, from, to); }); return finish(s); }())
    };
    out.byPlatform = group(list, function (p) { return p.platform; }, function (p, k) { return p.platform_label || platformLabel(k); }, from, to);
    out.bySport = group(list, function (p) { return p.sport ? String(p.sport).toUpperCase() : 'UNSPECIFIED'; },
      function (p, k) { return k === 'UNSPECIFIED' ? 'No sport recorded' : k; }, from, to);
    out.byPositionType = group(list, function (p) { return upperTrim(p.position_type) || 'OTHER'; },
      function (p, k) { return POSITION_TYPE_LABEL[k] || k; }, from, to);
    out.bySource = group(list, function (p) { return upperTrim(p.edge_source) || 'UNSPECIFIED'; },
      function (p, k) { return { EDGEDESK: 'EdgeDesk research', SELF: 'My own read', OTHER: 'Other source', UNSPECIFIED: 'Not recorded' }[k] || k; }, from, to);
    out.platform = extremes(out.byPlatform);
    out.sport = extremes(out.bySport.filter(function (g) { return g.key !== 'UNSPECIFIED'; }));
    out.marketType = extremes(out.byPositionType);
    out.series = series(list, { from: from, to: to, tz: opts.tz });
    return out;
  }
  /* cumulative settled P&L, one point per local settlement day */
  function series(positions, opts) {
    opts = opts || {};
    var by = {}, keys = [];
    (positions || []).forEach(function (p) {
      if (!isSettled(p)) return;
      var t = ms(p.settled_at), pl = P(p.profit_loss);
      if (t == null || !pl || !inRange(t, opts.from, opts.to)) return;
      var day = localDate(t, opts.tz);
      if (!by[day]) { by[day] = ZERO; keys.push(day); }
      by[day] = add(by[day], pl);
    });
    keys.sort();
    var run = ZERO;
    return keys.map(function (k) { run = add(run, by[k]); return { date: k, pnl: S(by[k]), cumulative: S(run) }; });
  }
  /* The calendar, one local day at a time, keeping apart the three questions
     public.portfolio_calendar() keeps apart: what SETTLED that day (the P&L,
     on the day the cumulative line counts it), which EVENTS started that day
     (and what is still at risk on them), and what was PLACED that day (and
     how much it cost). opts: { tz, month: 'YYYY-MM', kind, platform }.
     Without a month, every day. `months` lists every month with any activity
     under the same kind and platform, whatever the month asked for. */
  function calendar(positions, opts) {
    opts = opts || {};
    var kind = upperTrim(opts.kind), platform = opts.platform || null, month = opts.month || null;
    var by = {}, seen = {}, tot = emptyStats(), placed = 0, staked = ZERO, events = 0, open = 0, exposure = ZERO;
    function day(t) {
      if (t == null) return null;
      var k = localDate(t, opts.tz), m = k.slice(0, 7);
      seen[m] = 1;
      if (month && m !== month) return null;
      return by[k] || (by[k] = { st: emptyStats(), settledIds: [], eventIds: [], placedIds: [], open: 0, exposure: ZERO, staked: ZERO });
    }
    (positions || []).forEach(function (p) {
      if (kind && kind !== 'ALL' && upperTrim(p.platform_type) !== kind) return;
      if (platform && p.platform !== platform) return;
      var settled = isSettled(p), d = settled ? day(ms(p.settled_at)) : null;
      if (d) { addTo(d.st, p, null, null); addTo(tot, p, null, null); d.settledIds.push(p.id); }
      if ((d = day(ms(p.event_start_at)))) {
        d.eventIds.push(p.id); events++;
        if (!settled) { var c = P(p.open_cost_basis) || ZERO; d.open++; d.exposure = add(d.exposure, c); open++; exposure = add(exposure, c); }
      }
      if ((d = day(ms(p.placed_at)))) {
        var b = P(p.cost_basis) || ZERO;
        d.placedIds.push(p.id); d.staked = add(d.staked, b); placed++; staked = add(staked, b);
      }
    });
    var days = Object.keys(by).sort().map(function (k) {
      var x = by[k], f = finish(x.st);
      return { date: k, pnl: f.pnl, roi: f.roi, settled: f.settled, record: f.record, settledCapital: f.settledCapital,
        events: x.eventIds.length, open: x.open, exposure: S(x.exposure), placed: x.placedIds.length, staked: S(x.staked),
        settledIds: x.settledIds, eventIds: x.eventIds, placedIds: x.placedIds };
    });
    var ranked = days.filter(function (d) { return d.settled > 0; });
    var up = 0, down = 0, even = 0;
    ranked.forEach(function (d) { var g = sgn(P(d.pnl)); if (g > 0) up++; else if (g < 0) down++; else even++; });
    ranked.sort(function (a, b) { return cmp(P(b.pnl), P(a.pnl)) || (a.date < b.date ? -1 : 1); });
    var t = finish(tot);
    return {
      month: month, months: Object.keys(seen).sort(), days: days,
      pnl: t.pnl, roi: t.roi, settled: t.settled, record: t.record, settledCapital: t.settledCapital, winRate: t.winRate,
      placed: placed, staked: S(staked), events: events, open: open, exposure: S(exposure),
      up: up, down: down, even: even,
      /* like every best / worst on the page: only when there are two to compare */
      best: ranked.length >= 2 ? ranked[0] : null, worst: ranked.length >= 2 ? ranked[ranked.length - 1] : null
    };
  }

  /* ═══ 7. TIME ═════════════════════════════════════════════════════════ */
  function tzOffset(t, tz) {
    var parts = {}, f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    f.formatToParts(new Date(t)).forEach(function (x) { parts[x.type] = x.value; });
    var asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
    return asUtc - Math.floor(t / 1000) * 1000;
  }
  function validTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (_) { return false; } }
  /* a wall-clock time in an IANA zone → epoch ms (DST-aware; a time that
     does not exist in the zone resolves forward, as most libraries do) */
  function zonedToUtc(y, mo, d, h, mi, s, tz) {
    var guess = Date.UTC(y, mo - 1, d, h || 0, mi || 0, s || 0);
    if (!tz || tz === 'UTC') return guess;
    var off = tzOffset(guess, tz), t = guess - off, off2 = tzOffset(t, tz);
    return off2 === off ? t : guess - off2;
  }
  function localDate(t, tz) {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
    } catch (_) { return new Date(t).toISOString().slice(0, 10); }
  }
  /* '7D' | '30D' | 'YTD' | 'ALL' → {from, to} in epoch ms */
  function periodRange(key, now, tz) {
    now = now == null ? Date.now() : now;
    if (key === '7D') return { from: now - 7 * 86400000, to: null };
    if (key === '30D') return { from: now - 30 * 86400000, to: null };
    if (key === 'YTD') { var y = +localDate(now, tz).slice(0, 4); return { from: zonedToUtc(y, 1, 1, 0, 0, 0, tz), to: null }; }
    return { from: null, to: null };
  }

  /* ═══ 8. FINGERPRINTS — the material the database hashes ═════════════ */
  /* the same steps as public.portfolio_norm_text(), in the same order */
  function normText(x) {
    return String(x == null ? '' : x).normalize('NFKD')
      .replace(/[A-Z]/g, function (c) { return c.toLowerCase(); }).replace(/[\t\n\v\f\r]/g, ' ')
      .replace(/['`]/g, '').replace(/[^ -~]/g, '').replace(/[^a-z0-9+.@ -]/g, ' ')
      .replace(/\s+(at|vs|v)\.?\s+/g, ' @ ').replace(/\s*@\s*/g, ' @ ').replace(/\s+/g, ' ').trim();
  }
  function numText(x) { var d = P(x); return d ? S(d) : ''; }
  function minuteUtc(x) { var t = ms(x); return t == null ? '' : new Date(t).toISOString().slice(0, 16); }
  function plat(x) { return String(x == null ? '' : x).trim().toLowerCase(); }
  /* a selection and its line as one token (public.portfolio_selection_token) */
  function selectionToken(selection, line) {
    var sel = normText(selection).replace(/\+/g, ''), l = numText(line);
    return l !== '' && sel.slice(-l.length) !== l ? (sel + ' ' + l).trim() : sel;
  }
  function wagerMaterial(n) {
    var am = n.odds_american != null && n.odds_american !== '' ? intAmerican(n.odds_american) : null;
    var price = am != null ? 'a' + am : (P(n.odds_decimal) ? 'd' + numText(n.odds_decimal) : '');
    return ['pf1', 'wager', plat(n.platform), normText(n.event_name), normText(n.market_name), selectionToken(n.selection, n.line),
      price, numText(n.stake), minuteUtc(n.placed_at)].join('|');
  }
  function contractMaterial(n) {
    return ['pf1', 'contract', plat(n.platform), normText(n.event_name), normText(n.market_name), normText(n.side), minuteUtc(n.placed_at)].join('|');
  }
  function fillMaterial(n) {
    return ['pf1', 'fill', plat(n.platform), normText(n.event_name), normText(n.market_name), normText(n.side),
      String(n.action == null ? '' : n.action).trim().toUpperCase(), numText(n.quantity), numText(n.price), minuteUtc(n.executed_at)].join('|');
  }
  function contractKey(n) { return [plat(n.platform), normText(n.event_name), normText(n.market_name), normText(n.side)].join('|'); }

  /* ═══ 9. WORDS AND NUMBERS ON THE PAGE ════════════════════════════════ */
  var MINUS = '−';
  function group3(intStr) { return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  /* $1,284.22 · +$1,284.22 with {sign:true} · −$482.13 */
  function money(x, opts) {
    var d = P(x);
    if (!d) return '—';
    var t = fixed(abs(d), (opts && opts.dp != null) ? opts.dp : 2), i = t.indexOf('.');
    var body = '$' + group3(i < 0 ? t : t.slice(0, i)) + (i < 0 ? '' : t.slice(i));
    var g = sgn(divRound(d, ONE, (opts && opts.dp != null) ? opts.dp : 2));
    return (g < 0 ? MINUS : (opts && opts.sign && g > 0 ? '+' : '')) + body;
  }
  /* a ratio ("0.074") as a percentage: +7.4% */
  function pct(x, dp, opts) {
    var d = P(x), k = dp == null ? 1 : dp;
    if (!d) return '\u2014';
    var v = divRound(mul(d, HUNDRED), ONE, k), g = sgn(v);
    return (g < 0 ? MINUS : (!(opts && opts.plain) && g > 0 ? '+' : '')) + fixed(abs(v), k) + '%';
  }
  function americanText(a) { var v = intAmerican(a); return v == null ? '—' : (v > 0 ? '+' + v : MINUS + Math.abs(v)); }
  /* a contract price: $0.61 (sub-cent prices keep their digits: $0.555) */
  function priceText(x) {
    var d = P(x);
    if (!d) return '—';
    var t = d.s <= 2 ? fixed(d, 2) : S(divRound(d, ONE, 4));
    return '$' + t;
  }
  function qtyText(x) {
    var d = P(x);
    if (!d) return '\u2014';
    var t = S(d), i = t.indexOf('.');
    return group3(i < 0 ? t : t.slice(0, i)) + (i < 0 ? '' : t.slice(i));
  }
  function tone(x) { var d = P(x); return !d ? 'flat' : sgn(d) > 0 ? 'up' : sgn(d) < 0 ? 'down' : 'flat'; }
  function recordText(r) { return r.won + '-' + r.lost + '-' + r.push; }

  return {
    VERSION: VERSION, dec: dec,
    PLATFORM_TYPES: PLATFORM_TYPES, POSITION_TYPES: POSITION_TYPES, POSITION_TYPE_LABEL: POSITION_TYPE_LABEL,
    WAGER_STATUSES: WAGER_STATUSES, CONTRACT_STATUSES: CONTRACT_STATUSES, RESULTS: RESULTS, SOURCES: SOURCES,
    CONNECTION_TYPES: CONNECTION_TYPES, ACCOUNT_STATUSES: ACCOUNT_STATUSES, ACCOUNT_STATUS_LABEL: ACCOUNT_STATUS_LABEL,
    TRANSACTION_TYPES: TRANSACTION_TYPES, STAKE_TYPES: STAKE_TYPES, EDGE_SOURCES: EDGE_SOURCES, EDGE_REF_TYPES: EDGE_REF_TYPES,
    PLATFORMS: PLATFORMS, PLATFORM_KEY_RE: PLATFORM_KEY_RE, customPlatformKey: customPlatformKey,
    platformLabel: platformLabel, resolvePlatform: resolvePlatform, platform: function (k) { return PLATFORM_BY_KEY[k] || null; },
    intAmerican: intAmerican, americanToDecimal: americanToDecimal, decimalToAmerican: decimalToAmerican,
    wagerProfit: wagerProfit, parlay: parlay, derive: derive, DERIVED: DERIVED,
    validateWager: validateWager, validateFill: validateFill,
    summarize: summarize, series: series, calendar: calendar, periodRange: periodRange, localDate: localDate,
    zonedToUtc: zonedToUtc, validTz: validTz,
    normText: normText, numText: numText, minuteUtc: minuteUtc,
    selectionToken: selectionToken, wagerMaterial: wagerMaterial, contractMaterial: contractMaterial, fillMaterial: fillMaterial, contractKey: contractKey,
    money: money, pct: pct, americanText: americanText, priceText: priceText, qtyText: qtyText, tone: tone, recordText: recordText
  };
}));
