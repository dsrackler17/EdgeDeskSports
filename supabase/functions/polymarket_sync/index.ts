// @ts-nocheck — two plain JavaScript cores (lib/edgedesk_radar.js, lib/edgedesk_poly_gateway.js) inlined in a .ts file, as kalshi_sync inlines its own.
// ============================================================
//  FILE:    supabase/functions/polymarket_sync/index.ts
//  TYPE:    Edge Function — Prediction Radar's scheduled job (EXPERIMENTAL)
//  DEPLOY:  supabase functions deploy polymarket_sync --no-verify-jwt
//  CRON:    supabase/polymarket_sync_cron.sql
//  SQL:     supabase/radar.sql
//  TESTS:   node tools/radar/sync_fn.test.js (imports THIS file; no network)
//  DOCS:    docs/prediction-radar.md
// ============================================================
// Polymarket's data is public: no Polymarket key is read or needed. Every
// request goes through the Radar gateway (copied in below): the
// POLYMARKET_DATA_ENABLED switch, the run's grant from poly_api_acquire(),
// per-host pacing, bounded backoff and the breaker. The grant is settled
// (poly_api_settle) whatever happens.
//
// MODES (POST body {"mode": ...}):
//   tonight   every 10 minutes. The covered leagues' open game events (Gamma
//             /sports, /events): their markets upserted, each matched ONCE to
//             one EdgeDesk game (signals.event_id) or left pending with its
//             reason; then, for the matched markets of games starting within
//             upcoming_hours, who holds each side (/v2/holders, one condition
//             per call, include_pnl) — only the pool's wallets are stored —
//             and each outcome's price (Gamma's outcome prices); the
//             resolution of matched markets whose game started in the last
//             two days; then the Radar record: every card subscribers now see
//             published once (radar_publish_cards), every started one graded
//             once (radar_grade_cards).
//   pool      nightly. The sports leaderboard (all time, by volume), the top
//             pool_size wallets marked in the pool, the rest out.
//   wallets   every 5 minutes through the night. The pool wallets least
//             recently read: their activity since their cursor (trades,
//             redemptions, splits, merges; at most wallet_max_pages pages,
//             else the history is TRUNCATED and the wallet is never
//             top-graded), the markets they traded (Gamma, 50 a call), the
//             covered trades stored with their transaction hashes, and each
//             newly resolved bet graded once: its close, CLV and the 5- and
//             15-minute follow from the CLOB price history.
//   grade     nightly, after wallets. Every pool wallet's grade from its
//             stored bets and the market-maker rule's aggregates, ranked,
//             written as ONE versioned run (radar_put_grades).
//
// THE RULES are radar_rules() (supabase/radar.sql), read at the start of
// every run: nothing below hard-codes a threshold.
//
// FAILURE AND DEGRADATION (public.poly_alerts):
//   FAILURE   a mode failed; a database write failed; the poke had no secret
//   DEGRADED  a Polymarket request failed (the run went on without it); the
//             budget or the breaker cut the run short
//   DRIFT     Polymarket sent a shape the parsers could not read
//   WARNING   matched markets starting within 12 hours that stayed unmapped
//
// AUTH. pg_cron sends the Vault secret polymarket_sync_cron_secret as
// x-cron-secret; it must equal POLYMARKET_SYNC_SECRET. A GET is a public
// health probe (BUILD only).
//
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (provided), POLYMARKET_SYNC_SECRET,
//      POLYMARKET_DATA_ENABLED ("on" — the function's own half of the switch;
//      public.radar_config's is the other, and both must be on).
// ============================================================

export const BUILD = "polymarket_sync@2026-10-29.6";

// ── BEGIN RADAR CORE ── copied from lib/edgedesk_radar.js by tools/radar/inline_core.js; do not edit here
/* ===========================================================================
   EdgeDesk PREDICTION RADAR — the grading core. EXPERIMENTAL.
   docs/prediction-radar.md

   What it answers, from Polymarket's public trade history and nothing else:
     1 who are the best sports bettors on Polymarket, graded on skill (CLV,
       the price a follower could get) and not only on profit;
     2 what they hold on tonight's games (the database aggregates that:
       supabase/radar.sql radar_tonight_cards);
     3 would following them have made money, at a price a follower could
       really get (research/radar/registration_h_radar_01.json, H-RADAR-01).
   It never says what anyone should do. It measures.

   ONE IMPLEMENTATION, THREE HOSTS
     supabase/functions/polymarket_sync   the scheduled job (a verbatim copy
                                          between BEGIN/END RADAR CORE markers,
                                          tools/radar/inline_core.js; a test
                                          fails on drift)
     research/radar/run_validation.js     the H-RADAR-01 holdout test
     tools/radar/*.test.js                the unit tests, on recorded fixtures

   THE RULES ARE NOT HERE. Every threshold (50 graded bets to be ranked, the
   5-minute follow, the 60-minute close, the market-maker rule, the Radar
   Score's weights ...) is ONE constant, public.radar_rules() in
   supabase/radar.sql. Every function below takes the rules as an argument
   and refuses to run without them (R.rules): the scheduled job reads
   radar_rules() at the start of each run; the validation runner uses the
   copy frozen in the H-RADAR-01 registration, and a test holds that copy
   equal to radar_rules().

   PRICES are probabilities in [0, 1] (Polymarket's share price, dollars per
   $1 payout). A settlement is 1 (the outcome won), 0 (lost) or 0.5 (a
   50-50 resolution); anything else is void and never graded.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EDRadar = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var R = { VERSION: 'edgedesk_radar/1', GRADING_VERSION: 'radar-grade-1', LINKER_VERSION: 'radar-link-1' };
  var MIN = 60000;

  /* ------------------------------------------------------------ the rules */
  R.RULE_KEYS = ['min_graded', 'top_wallets', 'pool_size', 'pool_period', 'pool_order', 'max_bets_per_wallet', 'wallet_max_pages',
    'follow_lag_min', 'follow_lag_alt_min', 'follow_max_gap_min', 'close_max_gap_min', 'conviction_high_x',
    'mm_two_sided_share', 'mm_median_trades', 'mm_max_net_ratio', 'hedger_two_sided_share',
    'score_weight_follow_roi', 'score_weight_clv_pct', 'score_weight_roi', 'score_shrink_n',
    'leagues', 'market_types', 'validation_min_followed', 'ci_level', 'bootstrap_resamples', 'bootstrap_seed',
    'follow_slippage_sensitivity'];
  /* H-RADAR-02's rules (rules_version 2) carry these as well: discovery by recent covered-league dollars, the
     high-frequency screen, the featured bar and the follower's cost (research/radar/H-RADAR-02/DESIGN.md).
     H-RADAR-01's frozen rules have no rules_version: they are version 1, and mean what they meant */
  R.RULE_KEYS_V2 = ['rules_version', 'pool_window_days', 'pool_min_covered_bets', 'discovery_max_rank', 'screen_actions', 'screen_days',
    'hf_changes_per_day', 'hf_sample_hours', 'hf_sample_days_ago', 'hf_change_gap_min', 'featured_min_score', 'follow_cost'];
  R.rulesVersion = function (r) { return r && Number(r.rules_version) >= 2 ? 2 : 1; };
  R.gradingVersion = function (r) { return R.rulesVersion(r) >= 2 ? 'radar-grade-2' : R.GRADING_VERSION; };
  /* the rules every function needs, or an error naming the missing ones:
     there is no default here (supabase/radar.sql radar_rules() is the constant) */
  R.rules = function (r) {
    if (!r || typeof r !== 'object') throw new Error('radar: the rules are required (public.radar_rules())');
    var keys = R.rulesVersion(r) >= 2 ? R.RULE_KEYS.concat(R.RULE_KEYS_V2) : R.RULE_KEYS;
    var missing = keys.filter(function (k) { return r[k] === undefined || r[k] === null; });
    if (missing.length) throw new Error('radar: the rules are missing ' + missing.join(', ') + ' (public.radar_rules())');
    return r;
  };

  /* ------------------------------------------------------------ small helpers */
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function r4(x) { return x == null ? null : Math.round(x * 1e4) / 1e4; }
  function r6(x) { return x == null ? null : Math.round(x * 1e6) / 1e6; }
  function pick(o, keys) { if (!o) return undefined; for (var i = 0; i < keys.length; i++) { var v = o[keys[i]]; if (v !== undefined && v !== null && v !== '') return v; } return undefined; }
  /* Polymarket writes times as epoch seconds, epoch ms, ISO strings, or
     "2026-10-30 00:15:00+00" (a space and a two-digit offset) */
  function ms(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? (v < 1e11 ? v * 1000 : v) : null;
    var s = String(v).trim();
    if (/^\d+(\.\d+)?$/.test(s)) { var n = Number(s); return n < 1e11 ? n * 1000 : n; }
    var t = Date.parse(s);
    if (isFinite(t)) return t;
    var m = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d(?::\d\d(?:\.\d+)?)?)\s*(Z|[+-]\d\d(?::?\d\d)?)?$/.exec(s);
    if (!m) return null;
    var off = m[3] || 'Z';
    if (/^[+-]\d\d$/.test(off)) off += ':00';
    else if (/^[+-]\d{4}$/.test(off)) off = off.slice(0, 3) + ':' + off.slice(3);
    t = Date.parse(m[1] + 'T' + m[2] + off);
    return isFinite(t) ? t : null;
  }
  function jsonList(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string' && v.trim().charAt(0) === '[') { try { var a = JSON.parse(v); return Array.isArray(a) ? a : null; } catch (_) { return null; } }
    return null;
  }
  function median(xs) {
    var s = xs.filter(function (x) { return x != null && isFinite(x); }).slice().sort(function (a, b) { return a - b; });
    if (!s.length) return null;
    var h = Math.floor(s.length / 2);
    return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
  }
  function mean(xs) { var s = xs.filter(function (x) { return x != null && isFinite(x); }); return s.length ? s.reduce(function (a, b) { return a + b; }, 0) / s.length : null; }
  function price(v) { var n = num(v); return n == null || n < 0 || n > 1 ? null : n; }
  function wallet(v) { var s = String(v == null ? '' : v).trim().toLowerCase(); return /^0x[0-9a-f]{40}$/.test(s) ? s : null; }
  R.num = num; R.ms = ms; R.median = median; R.mean = mean; R.wallet = wallet;

  /* ------------------------------------------------------------ the API's rows
     Each reader takes what Polymarket sends and returns EdgeDesk's shape, or
     null with no guess. Both spellings are read: the v1 endpoints send
     camelCase (proxyWallet, conditionId), the v2 ones snake_case. */
  R.page = function (json) {
    if (Array.isArray(json)) return { rows: json, next_cursor: null, has_more: false };
    if (!json || typeof json !== 'object') return { rows: [], next_cursor: null, has_more: false };
    var rows = json.data || json.results || json.items || json.leaderboard || json.rows || json.history || [];
    var pg = json.pagination || json.page || {};
    var cursor = pick(pg, ['next_cursor', 'nextCursor', 'cursor']) || pick(json, ['next_cursor', 'nextCursor']) || null;
    var more = pg.has_more != null ? !!pg.has_more : (pg.hasMore != null ? !!pg.hasMore : !!cursor);
    return { rows: Array.isArray(rows) ? rows : [], next_cursor: more ? cursor : null, has_more: more && !!cursor };
  };

  /* one leaderboard row: the candidate pool */
  R.leaderRow = function (x) {
    var w = wallet(pick(x, ['proxyWallet', 'proxy_wallet', 'wallet', 'address', 'user']));
    if (!w) return null;
    return { wallet: w, rank: num(pick(x, ['rank', 'position'])), volume: num(pick(x, ['vol', 'volume', 'amount'])), pnl: num(pick(x, ['pnl', 'profit'])),
      name: pick(x, ['userName', 'user_name', 'username', 'name']) || null, x_username: pick(x, ['xUsername', 'x_username']) || null,
      verified: !!pick(x, ['verifiedBadge', 'verified_badge', 'verified']) };
  };

  /* one activity row: a trade (BUY / SELL), a redemption, a split or a merge */
  R.activityRow = function (a, owner) {
    var type = String(pick(a, ['type', 'activity_type', 'activityType']) || 'TRADE').toUpperCase();
    var w = wallet(pick(a, ['proxyWallet', 'proxy_wallet', 'user', 'wallet'])) || wallet(owner);
    var tx = String(pick(a, ['transactionHash', 'transaction_hash', 'tx_hash', 'txHash']) || '').toLowerCase();
    var at = ms(pick(a, ['timestamp', 'time', 'created_at', 'createdAt', 'match_time']));
    var cond = String(pick(a, ['conditionId', 'condition_id', 'market']) || '').toLowerCase() || null;
    var row = { wallet: w, kind: type, tx_hash: tx || null, ts: at, condition_id: cond,
      token_id: pick(a, ['asset', 'token_id', 'tokenId', 'asset_id']) != null ? String(pick(a, ['asset', 'token_id', 'tokenId', 'asset_id'])) : null,
      outcome_index: num(pick(a, ['outcomeIndex', 'outcome_index'])), outcome: pick(a, ['outcome']) || null,
      side: null, size: num(pick(a, ['size', 'shares', 'amount'])), price: null, usdc: num(pick(a, ['usdcSize', 'usdc_size', 'usdc'])),
      slug: pick(a, ['slug', 'market_slug', 'marketSlug']) || null, event_slug: pick(a, ['eventSlug', 'event_slug']) || null,
      title: pick(a, ['title', 'question']) || null };
    if (type === 'TRADE') {
      var side = String(pick(a, ['side']) || '').toUpperCase();
      row.side = side === 'BUY' || side === 'SELL' ? side : null;
      row.price = price(pick(a, ['price']));
      if (row.usdc == null && row.size != null && row.price != null) row.usdc = row.size * row.price;
    }
    /* a row EdgeDesk cannot verify on chain, or price, is not a row */
    if (!row.wallet || !row.tx_hash || !/^0x[0-9a-f]{64}$/.test(row.tx_hash) || row.ts == null || !row.condition_id) return null;
    if (type === 'TRADE' && (!row.side || row.price == null || !(row.size > 0) || !row.token_id)) return null;
    return row;
  };

  var LEAGUE_ALIASES = { nfl: 'nfl', cfb: 'cfb', ncaaf: 'cfb', 'college-football': 'cfb', 'ncaa-football': 'cfb', cfp: 'cfb',
    nba: 'nba', nhl: 'nhl', mlb: 'mlb' };
  R.LEAGUE_SPORT = { nfl: 'americanfootball_nfl', cfb: 'americanfootball_ncaaf', nba: 'basketball_nba', nhl: 'icehockey_nhl', mlb: 'baseball_mlb' };
  function leagueOf(m, ev) {
    var cands = [];
    var add = function (s) { if (s) cands.push(String(s).toLowerCase()); };
    if (ev) {
      add(ev.seriesSlug); add(ev.series_slug);
      (ev.series || []).forEach(function (s) { add(s && (s.slug || s.ticker)); });
      (ev.tags || []).forEach(function (t) { add(t && (t.slug || t.label)); });
    }
    (m.tags || []).forEach(function (t) { add(t && (t.slug || t.label)); });
    for (var i = 0; i < cands.length; i++) if (LEAGUE_ALIASES[cands[i]]) return { league: LEAGUE_ALIASES[cands[i]], source: 'tag' };
    /* game event slugs open with the league: nfl-kc-buf-2026-11-16 */
    var slugs = [ev && (ev.slug || ev.ticker), m.slug, m.event_slug, m.eventSlug].filter(Boolean).map(function (s) { return String(s).toLowerCase(); });
    for (var j = 0; j < slugs.length; j++) {
      var p = /^([a-z]+)-/.exec(slugs[j]);
      if (p && LEAGUE_ALIASES[p[1]]) return { league: LEAGUE_ALIASES[p[1]], source: 'slug' };
    }
    return { league: null, source: null };
  }
  var TYPE_ALIASES = { moneyline: 'moneyline', spreads: 'spreads', spread: 'spreads', totals: 'totals', total: 'totals' };

  /* one Gamma market: what it is, which game, when it starts, how it settled */
  R.marketRow = function (m, ev) {
    if (!m || typeof m !== 'object') return null;
    ev = ev || (Array.isArray(m.events) && m.events[0]) || null;
    var cond = String(pick(m, ['conditionId', 'condition_id']) || '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(cond)) return null;
    var outcomes = jsonList(m.outcomes) || [], tokens = (jsonList(pick(m, ['clobTokenIds', 'clob_token_ids'])) || []).map(String);
    var prices = (jsonList(pick(m, ['outcomePrices', 'outcome_prices'])) || []).map(num);
    var lg = leagueOf(m, ev);
    var rawType = String(pick(m, ['sportsMarketType', 'sports_market_type']) || '').toLowerCase();
    var type = TYPE_ALIASES[rawType] || null, typeSource = type ? 'gamma' : null;
    var q = String(pick(m, ['question', 'title']) || '');
    /* a two-team market with no type: a moneyline when its question names the
       same two teams as its outcomes ("Chiefs vs. Raiders"), nothing else */
    if (!type && !rawType && outcomes.length === 2 && !/^(yes|no|over|under)$/i.test(outcomes[0]) && !/^(yes|no|over|under)$/i.test(outcomes[1])) {
      var vs = /^(.+?)\s+(?:vs\.?|v\.?|@|at)\s+(.+?)\??$/i.exec(q.trim());
      if (vs && teamKey(vs[1]) === teamKey(outcomes[0]) && teamKey(vs[2]) === teamKey(outcomes[1])) { type = 'moneyline'; typeSource = 'question'; }
    }
    var start = ms(pick(m, ['gameStartTime', 'game_start_time', 'eventStartTime', 'event_start_time'])) || (ev ? ms(pick(ev, ['startTime', 'start_time', 'gameStartTime'])) : null);
    var closed = !!pick(m, ['closed']);
    var resolvedStatus = String(pick(m, ['umaResolutionStatus', 'uma_resolution_status']) || '').toLowerCase();
    var settle = null;
    if (closed && prices.length === outcomes.length && prices.length >= 2 && prices.every(function (p) { return p === 0 || p === 1 || p === 0.5; })
        && Math.abs(prices.reduce(function (a, b) { return a + b; }, 0) - 1) < 1e-9 && resolvedStatus !== 'disputed' && resolvedStatus !== 'proposed') settle = prices;
    return {
      condition_id: cond, market_id: pick(m, ['id']) != null ? String(m.id) : null, question: q || null, slug: m.slug || null,
      event_slug: (ev && ev.slug) || pick(m, ['eventSlug', 'event_slug']) || null, event_ref: ev && ev.id != null ? String(ev.id) : null,
      event_title: (ev && ev.title) || null, league: lg.league, league_source: lg.source,
      market_type: type, type_source: typeSource, raw_type: rawType || null,
      /* Gamma's point is "line"; its "spread" is the order book's bid-ask
         spread (0.001 on a moneyline), never a point */
      line: num(pick(m, ['line'])),
      outcomes: outcomes.map(String), token_ids: tokens, game_start_at: start,
      closed: closed, settle: settle,
      last_prices: closed ? null : prices.map(price),
      end_at: ms(pick(m, ['endDate', 'end_date', 'endDateIso'])), active: !!pick(m, ['active']), accepting: pick(m, ['acceptingOrders', 'accepting_orders']),
      /* what the market charges a taker, as it says itself (probe run 40975470572: covered sports markets send
         feesEnabled true, feeType "zero_fees" and feeSchedule.rate 0). A market without fees enabled charges none */
      fees_enabled: pick(m, ['feesEnabled', 'fees_enabled']) == null ? null : !!pick(m, ['feesEnabled', 'fees_enabled']), fee_schedule: feeSchedule(m)
    };
  };
  function feeSchedule(m) {
    var s = pick(m, ['feeSchedule', 'fee_schedule']);
    if (typeof s === 'string') { try { s = JSON.parse(s); } catch (e) { s = null; } }
    if (!s || typeof s !== 'object') return null;
    return { rate: num(s.rate), exponent: num(s.exponent), taker_only: s.takerOnly != null ? !!s.takerOnly : (s.taker_only != null ? !!s.taker_only : null),
      fee_type: pick(m, ['feeType', 'fee_type']) || null };
  }
  /* the fee a follower pays a share: 0 when the market says it charges none (fees not enabled, or a schedule rate
     of 0); null when it charges something, because Polymarket's formula is not confirmed here (H-RADAR-02
     DESIGN.md, Fees), and null when the market's fee status was never read. An unknown fee is never guessed */
  R.followFee = function (market) {
    if (!market || market.fees_enabled == null) return null;
    if (market.fees_enabled === false) return 0;
    var s = market.fee_schedule;
    return s && s.rate === 0 ? 0 : null;
  };

  /* a CLOB price history: [{t, p}] ascending, t in ms */
  R.priceHistory = function (json) {
    var rows = Array.isArray(json) ? json : (json && (json.history || json.data)) || [];
    return rows.map(function (x) { return { t: ms(pick(x, ['t', 'timestamp', 'time'])), p: price(pick(x, ['p', 'price'])) }; })
      .filter(function (x) { return x.t != null && x.p != null; })
      .sort(function (a, b) { return a.t - b.t; });
  };

  /* the holders of one market, each side: who, how many shares, at what average price */
  R.holderRows = function (json, conditionId) {
    var out = [];
    var groups = Array.isArray(json) ? json : (json && (json.data || json.holders || json.tokens)) || [];
    var push = function (h, tokenFallback) {
      var w = wallet(pick(h, ['proxyWallet', 'proxy_wallet', 'wallet', 'address', 'user']));
      var shares = num(pick(h, ['amount', 'shares', 'size', 'balance']));
      if (!w || !(shares > 0)) return;
      var avg = price(pick(h, ['avgPrice', 'avg_price', 'averagePrice', 'average_price', 'avg_entry_price']));
      var tok = pick(h, ['asset', 'token_id', 'tokenId', 'token']);
      out.push({ condition_id: conditionId ? String(conditionId).toLowerCase() : null, token_id: tok != null ? String(tok) : (tokenFallback != null ? String(tokenFallback) : null),
        outcome_index: num(pick(h, ['outcomeIndex', 'outcome_index'])), wallet: w, shares: shares, avg_price: avg,
        cost: avg == null ? null : shares * avg, pnl: num(pick(h, ['pnl', 'cashPnl', 'cash_pnl', 'realizedPnl', 'realized_pnl', 'total_pnl'])),
        name: pick(h, ['name', 'userName', 'username', 'user_name']) || null, pseudonym: pick(h, ['pseudonym']) || null,
        display_public: pick(h, ['displayUsernamePublic', 'display_username_public']) === true });
    };
    groups.forEach(function (g) {
      if (g && Array.isArray(g.holders)) g.holders.forEach(function (h) { push(h, pick(g, ['token', 'token_id', 'asset'])); });
      else push(g, null);
    });
    return out;
  };

  /* ------------------------------------------------------------ prices in time */
  /* the last recorded price at or before t, no older than maxGapMs; else null */
  R.priceAt = function (hist, t, maxGapMs) {
    if (!hist || !hist.length || t == null) return null;
    var lo = 0, hi = hist.length - 1, best = -1;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (hist[mid].t <= t) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    if (best < 0) return null;
    if (maxGapMs != null && t - hist[best].t > maxGapMs) return null;
    return { p: hist[best].p, t: hist[best].t };
  };

  /* ------------------------------------------------------------ bets */
  /* every trade of one wallet, grouped by outcome token, read against the
     markets: a BET is a position whose FIRST buy came before the game start */
  R.buildBets = function (trades, markets, rules) {
    rules = R.rules(rules);
    var byToken = {}, splitMerge = {}, out = { bets: [], skipped: {} };
    var skip = function (k) { out.skipped[k] = (out.skipped[k] || 0) + 1; };
    (trades || []).forEach(function (t) {
      if (!t) return;
      if (t.kind === 'SPLIT' || t.kind === 'MERGE' || t.kind === 'CONVERSION') { splitMerge[t.condition_id] = true; return; }
      if (t.kind !== 'TRADE') return;
      var k = t.wallet + '|' + t.token_id;
      (byToken[k] = byToken[k] || []).push(t);
    });
    Object.keys(byToken).sort().forEach(function (k) {
      var ts = byToken[k].slice().sort(function (a, b) { return a.ts - b.ts || (a.tx_hash < b.tx_hash ? -1 : 1); });
      var t0 = ts[0], m = markets[t0.condition_id];
      if (!m) return skip('no_market');
      if (!covered(m, rules)) return skip('not_covered');
      if (m.game_start_at == null) return skip('no_start');
      var oi = t0.outcome_index != null ? t0.outcome_index : m.token_ids.indexOf(String(t0.token_id));
      if (oi == null || oi < 0) return skip('no_outcome');
      var buys = ts.filter(function (x) { return x.side === 'BUY'; });
      if (!buys.length) return skip('sell_only');
      if (buys[0].ts >= m.game_start_at) return skip('in_play_entry');
      if (splitMerge[t0.condition_id]) return skip('split_merge');
      var pre = buys.filter(function (x) { return x.ts < m.game_start_at; });
      var preShares = pre.reduce(function (a, x) { return a + x.size; }, 0), stake = pre.reduce(function (a, x) { return a + x.size * x.price; }, 0);
      var buyCost = buys.reduce(function (a, x) { return a + x.size * x.price; }, 0), boughtShares = buys.reduce(function (a, x) { return a + x.size; }, 0);
      var sells = ts.filter(function (x) { return x.side === 'SELL'; });
      var proceeds = sells.reduce(function (a, x) { return a + x.size * x.price; }, 0), soldShares = sells.reduce(function (a, x) { return a + x.size; }, 0);
      var held = boughtShares - soldShares;
      if (held < -1e-6) return skip('sold_more_than_bought');
      var settle = m.settle ? m.settle[oi] : null;
      var bet = {
        wallet: t0.wallet, condition_id: m.condition_id, token_id: String(t0.token_id), outcome_index: oi, outcome: m.outcomes[oi] || t0.outcome || null,
        league: m.league, market_type: m.market_type, line: m.line, event_slug: m.event_slug, event_ref: m.event_ref, question: m.question,
        game_start_at: m.game_start_at, entry_at: buys[0].ts, entry_tx: buys[0].tx_hash, entry_price: r6(stake / preShares),
        stake: r6(stake), shares_pregame: r6(preShares), buy_cost: r6(buyCost), sell_proceeds: r6(proceeds), shares_held: r6(Math.max(held, 0)),
        trades: ts.length, txs: ts.map(function (x) { return x.tx_hash; }).filter(function (h, i, a) { return a.indexOf(h) === i; }),
        settle: settle, result: settle == null ? (m.closed ? 'void' : 'open') : (settle === 1 ? 'win' : settle === 0 ? 'loss' : 'push'),
        profit: settle == null ? null : r6(proceeds + settle * Math.max(held, 0) - buyCost),
        follow_fee: R.followFee(m)   /* what a follower would pay the market a share (version 2 grades only) */
      };
      out.bets.push(bet);
    });
    return out;
  };
  function covered(m, rules) { return !!m && rules.leagues.indexOf(m.league) >= 0 && rules.market_types.indexOf(m.market_type) >= 0; }
  R.covered = function (m, rules) { return covered(m, R.rules(rules)); };

  /* the close, CLV and the follow prices of one bet, from its token's price
     history. CLV% is the house formula (close/index.ts: entryDec x closeFair
     - 1, with entryDec = 1 / entry price and closeFair = the close). */
  R.gradeBet = function (bet, hist, rules) {
    rules = R.rules(rules);
    var g = Object.assign({}, bet);
    var start = bet.game_start_at;
    var c = R.priceAt(hist, start, rules.close_max_gap_min * MIN);
    g.close_price = c ? c.p : null; g.close_at = c ? c.t : null;
    g.clv_pp = c && bet.entry_price != null ? r4((c.p - bet.entry_price) * 100) : null;
    g.clv_pct = c && bet.entry_price > 0 ? r6(c.p / bet.entry_price - 1) : null;
    [[rules.follow_lag_min, '5'], [rules.follow_lag_alt_min, '15']].forEach(function (L) {
      var at = bet.entry_at + L[0] * MIN, f = at < start ? R.priceAt(hist, at, rules.follow_max_gap_min * MIN) : null;
      var p = f && f.p > 0 && f.p < 1 ? f.p : null;
      g['follow' + L[1] + '_price'] = p; g['follow' + L[1] + '_at'] = p == null ? null : f.t;
      g['follow' + L[1] + '_reason'] = p != null ? null : (at >= start ? 'started_before_follow' : (f ? 'price_at_bound' : 'no_price_near_follow'));
      g['follow' + L[1] + '_roi'] = p != null && bet.settle != null ? r6(bet.settle / p - 1) : null;
      g['beat_close' + L[1]] = p != null && c ? c.p > p : null;
    });
    return R.rulesVersion(rules) >= 2 ? R.followCost(g, rules) : g;
  };
  /* version 2 (H-RADAR-02): what a follower really pays. The price history is the midpoint (probe run
     40975470572), and a follower buys at the ask, so the follow price is the midpoint plus follow_cost (1 cent),
     and a follow is graded only when the market's fee is known (R.followFee): a known 0 is no fee; an unknown fee
     leaves the follow ungraded with its reason. A price of 1 or more cannot be bought. Beat-the-close compares
     the close with the price paid. The grade reads only the midpoints a version-1 grade stored, so a stored
     version-1 bet is graded to version 2 with no new read (R.followCost on it gives the same as on the history) */
  R.followCost = function (g1, rules) {
    rules = R.rules(rules);
    var g = Object.assign({}, g1), fee = g1.follow_fee !== undefined ? g1.follow_fee : null;
    ['5', '15'].forEach(function (k) {
      var mid = g1['follow' + k + '_mid'] != null ? Number(g1['follow' + k + '_mid']) : (g1['follow' + k + '_price'] != null ? Number(g1['follow' + k + '_price']) : null);
      g['follow' + k + '_mid'] = mid;
      if (mid == null) { g['follow' + k + '_price'] = null; g['follow' + k + '_roi'] = null; g['beat_close' + k] = null; return; }
      var p = r6(mid + rules.follow_cost), why = null;
      if (!(p < 1)) why = 'price_at_bound';
      else if (fee == null) why = 'fee_unknown';
      else if (fee !== 0) why = 'fee_unknown';
      if (why) { g['follow' + k + '_price'] = null; g['follow' + k + '_at'] = null; g['follow' + k + '_reason'] = why; g['follow' + k + '_roi'] = null; g['beat_close' + k] = null; return; }
      g['follow' + k + '_price'] = p;
      g['follow' + k + '_roi'] = g1.settle != null ? r6(Number(g1.settle) / p - 1) : null;
      g['beat_close' + k] = g1.close_price != null ? Number(g1.close_price) > p : null;
    });
    g.grading_version = R.gradingVersion(rules);
    return g;
  };

  /* the stretches of a bet's price history its grade reads. R.priceAt takes the
     last point at or before its moment, at most a gap older, so the follows read
     [entry + 5 - 10, entry + 15] minutes and the close [start - 60, start]:
     these alone give the same grade as the whole history (core.test.js), and a
     bet placed days early is two short reads, not a point a minute for days.
     Stretches that meet are one read, 15 minutes before the entry to a minute
     after the start, as before. Times in ms, a minute's margin each side. */
  R.gradeWindows = function (bet, rules) {
    rules = R.rules(rules);
    var e = bet.entry_at, s = bet.game_start_at;
    var lagLo = Math.min(rules.follow_lag_min, rules.follow_lag_alt_min), lagHi = Math.max(rules.follow_lag_min, rules.follow_lag_alt_min);
    var whole = { from: e - 15 * MIN, to: s + MIN };
    var follow = { from: Math.max(whole.from, e + (lagLo - rules.follow_max_gap_min - 1) * MIN), to: e + (lagHi + 1) * MIN };
    var close = { from: s - (rules.close_max_gap_min + 1) * MIN, to: s + MIN };
    return follow.to >= close.from ? [whole] : [follow, close];
  };

  /* ------------------------------------------------------------ style */
  /* Market Maker, Hedger or Directional, from how a wallet trades the covered
     markets: two-sided markets (both outcomes bought, or a split / merge),
     trades per market, and how lopsided its shares are */
  R.styleOf = function (trades, markets, rules) {
    rules = R.rules(rules);
    var per = {};
    (trades || []).forEach(function (t) {
      if (!t || !t.condition_id) return;
      var m = markets[t.condition_id];
      if (!covered(m, rules)) return;
      var p = per[t.condition_id] = per[t.condition_id] || { condition_id: t.condition_id, trades: 0, bought: {}, split: false };
      if (t.kind === 'SPLIT' || t.kind === 'MERGE' || t.kind === 'CONVERSION') { p.split = true; return; }
      if (t.kind !== 'TRADE') return;
      p.trades++;
      if (t.side === 'BUY') { var oi = t.outcome_index != null ? t.outcome_index : m.token_ids.indexOf(String(t.token_id)); p.bought[oi] = (p.bought[oi] || 0) + t.size; }
    });
    return R.styleFromStats(Object.keys(per).map(function (k) { return per[k]; }), rules);
  };
  /* the same rule from per-market aggregates (supabase/radar.sql
     radar_style_stats(): one row per wallet and covered market) */
  R.styleFromStats = function (stats, rules) {
    rules = R.rules(rules);
    var rows = (stats || []).filter(Boolean);
    if (!rows.length) return { style: 'Directional', markets: 0, two_sided_share: 0, median_trades: null, median_net_ratio: null };
    var two = 0, tr = [], nr = [];
    rows.forEach(function (p) {
      var b = p.bought || {}, sides = Object.keys(b).filter(function (o) { return num(b[o]) > 0; });
      if (sides.length >= 2 || p.split) two++;
      tr.push(num(p.trades) || 0);
      var a = num(b[0]) || 0, c = num(b[1]) || 0;
      if (a + c > 0) nr.push(Math.abs(a - c) / (a + c));
    });
    var share = two / rows.length, mt = median(tr), mn = median(nr);
    var style = 'Directional';
    if (share >= rules.mm_two_sided_share && mt != null && mt >= rules.mm_median_trades && mn != null && mn <= rules.mm_max_net_ratio) style = 'Market Maker';
    else if (share >= rules.hedger_two_sided_share) style = 'Hedger';
    return { style: style, markets: rows.length, two_sided_share: r4(share), median_trades: mt, median_net_ratio: r4(mn) };
  };

  /* ------------------------------------------------------------ one wallet's grade */
  R.conviction = function (stake, medianStake) { return stake > 0 && medianStake > 0 ? r4(stake / medianStake) : null; };
  function shrink(x, m, k) { return x == null || !m ? 0 : x * m / (m + k); }
  R.radarScore = function (c, rules) {
    rules = R.rules(rules);
    var k = rules.score_shrink_n;
    var parts = {
      follow_roi: shrink(c.follow5_roi, c.follow5_n, k), clv_pct: shrink(c.clv_pct, c.clv_n, k), roi: shrink(c.roi, c.graded_bets, k)
    };
    var s = 100 * (rules.score_weight_follow_roi * parts.follow_roi + rules.score_weight_clv_pct * parts.clv_pct + rules.score_weight_roi * parts.roi);
    return { score: Math.round(s * 100) / 100, shrunk: { follow_roi: r6(parts.follow_roi), clv_pct: r6(parts.clv_pct), roi: r6(parts.roi) } };
  };
  /* graded = resolved, not void; the most recent max_bets_per_wallet of them */
  R.gradeWallet = function (gradedBets, style, rules) {
    rules = R.rules(rules);
    var bets = (gradedBets || []).filter(function (b) { return b && b.settle != null && b.profit != null; })
      .sort(function (a, b) { return b.entry_at - a.entry_at || (a.token_id < b.token_id ? -1 : 1); }).slice(0, rules.max_bets_per_wallet);
    var n = bets.length;
    var sum = function (f) { return bets.reduce(function (a, b) { return a + (f(b) || 0); }, 0); };
    var cost = sum(function (b) { return b.buy_cost; }), profit = sum(function (b) { return b.profit; });
    var clv = bets.filter(function (b) { return b.clv_pct != null; });
    var f5 = bets.filter(function (b) { return b.follow5_roi != null; }), f15 = bets.filter(function (b) { return b.follow15_roi != null; });
    var bc = bets.filter(function (b) { return b.beat_close5 != null; });
    var med = median(bets.map(function (b) { return b.stake; }));
    var g = {
      wallet: n ? bets[0].wallet : null, graded_bets: n,
      wins: bets.filter(function (b) { return b.result === 'win'; }).length, losses: bets.filter(function (b) { return b.result === 'loss'; }).length,
      pushes: bets.filter(function (b) { return b.result === 'push'; }).length,
      staked: r6(cost), profit: r6(profit), roi: cost > 0 ? r6(profit / cost) : null,
      clv_n: clv.length, clv_pp: clv.length ? r4(mean(clv.map(function (b) { return b.clv_pp; }))) : null,
      clv_pct: clv.length ? r6(mean(clv.map(function (b) { return b.clv_pct; }))) : null,
      follow5_n: f5.length, follow5_roi: f5.length ? r6(mean(f5.map(function (b) { return b.follow5_roi; }))) : null,
      follow15_n: f15.length, follow15_roi: f15.length ? r6(mean(f15.map(function (b) { return b.follow15_roi; }))) : null,
      beat_close5_rate: bc.length ? r4(bc.filter(function (b) { return b.beat_close5; }).length / bc.length) : null,
      median_stake: med == null ? null : r6(med),
      style: (style && style.style) || 'Directional', style_detail: style || null,
      sample: n >= rules.min_graded ? 'ranked' : 'small_sample',
      first_bet_at: n ? bets[n - 1].entry_at : null, last_bet_at: n ? bets[0].entry_at : null
    };
    g.radar_score = null; g.score_parts = null;
    if (g.sample === 'ranked') { var s = R.radarScore(g, rules); g.radar_score = s.score; g.score_parts = s.shrunk; }
    return g;
  };
  /* rank every ranked wallet by Radar Score; the top_wallets DIRECTIONAL ones
     (history complete) are the top-graded wallets Smart Money Tonight counts */
  R.rankWallets = function (grades, rules) {
    rules = R.rules(rules);
    var ranked = (grades || []).filter(function (g) { return g && g.sample === 'ranked' && g.radar_score != null; })
      .sort(function (a, b) { return b.radar_score - a.radar_score || b.graded_bets - a.graded_bets || (a.wallet < b.wallet ? -1 : 1); });
    var top = 0, v2 = R.rulesVersion(rules) >= 2;
    ranked.forEach(function (g, i) {
      g.rank = i + 1;
      /* version 2 (H-RADAR-02): featured only with a Radar Score above featured_min_score, never a high-frequency
         wallet, at most top_wallets of them; fewer when fewer qualify */
      g.top_directional = g.style === 'Directional' && !g.history_truncated && top < rules.top_wallets
        && (!v2 || (!g.high_frequency && g.radar_score > rules.featured_min_score));
      if (g.top_directional) top++;
    });
    (grades || []).forEach(function (g) { if (g && g.sample !== 'ranked') { g.rank = null; g.top_directional = false; } });
    return ranked;
  };

  /* ------------------------------------------------------------ the high-frequency screen (H-RADAR-02) */
  /* position changes, not fills: a run of fills on one token and one side, each within hf_change_gap_min of the
     last, is one change (a large order filled in pieces counts once). Rows: activity rows (R.activityRow) */
  R.positionChanges = function (rows, rules) {
    rules = R.rules(rules);
    var gap = rules.hf_change_gap_min * MIN, last = {}, n = 0;
    (rows || []).filter(function (t) { return t && t.kind === 'TRADE' && t.ts != null; }).sort(function (a, b) { return a.ts - b.ts; }).forEach(function (t) {
      var k = t.token_id + '|' + t.side;
      if (!(last[k] != null && t.ts - last[k] <= gap)) n++;
      last[k] = t.ts;
    });
    return n;
  };
  /* the screening flag: one newest-first page held screen_actions with more to come, inside screen_days. A flag
     only sends a wallet to the samples; it proves nothing */
  R.screenFlag = function (rows, hasMore, nowMs, rules) {
    rules = R.rules(rules);
    var ts = (rows || []).map(function (r) { return r && r.ts; }).filter(function (t) { return t != null; });
    if (!hasMore || ts.length < rules.screen_actions) return false;
    return nowMs - Math.min.apply(null, ts) < rules.screen_days * 24 * 60 * MIN;
  };
  /* one sample: the hf_sample_hours ending at its moment. read = the rows read for that span (null when the read
     failed), complete = the span was read to its start. Unknown when the read failed, or when it stopped short and
     the changes it holds do not already exceed the bar: a missing sample is never low activity */
  R.hfSample = function (read, complete, rules) {
    rules = R.rules(rules);
    if (read == null) return { known: false, changes_per_day: null, reason: 'unread' };
    var perDay = R.positionChanges(read, rules) * 24 / rules.hf_sample_hours, bar = rules.hf_changes_per_day;
    if (!complete && !(perDay > bar)) return { known: false, changes_per_day: null, at_least: r4(perDay), reason: 'incomplete' };
    return { known: true, changes_per_day: r4(perDay), complete: !!complete };
  };
  /* high-frequency, not followable: every sample known and above hf_changes_per_day. Anything less is not that
     label (a wallet with an unknown sample is judged on its history, or left ungraded at the cap) */
  R.hfVerdict = function (samples, rules) {
    rules = R.rules(rules);
    var want = rules.hf_sample_days_ago.length;
    var ok = (samples || []).length === want && samples.every(function (x) { return x && x.known && x.changes_per_day > rules.hf_changes_per_day; });
    return { high_frequency: ok, samples: samples || [] };
  };
  /* the spans of the three samples, [from, to) in ms, for a moment now */
  R.hfSpans = function (nowMs, rules) {
    rules = R.rules(rules);
    return rules.hf_sample_days_ago.map(function (d) { var to = nowMs - d * 24 * 60 * MIN; return { days_ago: d, from: to - rules.hf_sample_hours * 60 * MIN, to: to }; });
  };

  /* ------------------------------------------------------------ the bootstrap */
  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function quantile(sorted, q) { if (!sorted.length) return null; var i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); }
  R.mulberry32 = mulberry32;
  /* the mean of rows' values with a percentile bootstrap that resamples whole
     GAMES: bets on one game share its news, its close and its result */
  R.clusterBootstrap = function (rows, o) {
    o = o || {};
    var B = o.B, seed = o.seed, level = o.level;
    if (!(B > 0) || seed == null || !(level > 0 && level < 1)) throw new Error('radar: clusterBootstrap needs B, seed and level (the rules)');
    var by = {}, keys = [];
    (rows || []).forEach(function (r) { var v = num(r.value); if (v == null) return; var k = String(r.cluster); if (!by[k]) { by[k] = []; keys.push(k); } by[k].push(v); });
    keys.sort();
    var n = keys.reduce(function (a, k) { return a + by[k].length; }, 0);
    if (!n) return { n: 0, clusters: 0, mean: null, lo: null, hi: null, B: B, seed: seed, level: level };
    var sums = keys.map(function (k) { return by[k].reduce(function (x, y) { return x + y; }, 0); }), cnts = keys.map(function (k) { return by[k].length; });
    var total = sums.reduce(function (a, b) { return a + b; }, 0);
    var rnd = mulberry32(seed), means = [];
    for (var b = 0; b < B; b++) {
      var s = 0, c = 0;
      for (var j = 0; j < keys.length; j++) { var i = Math.floor(rnd() * keys.length); s += sums[i]; c += cnts[i]; }
      means.push(s / c);
    }
    means.sort(function (x, y) { return x - y; });
    var a = (1 - level) / 2;
    return { n: n, clusters: keys.length, mean: r6(total / n), lo: r6(quantile(means, a)), hi: r6(quantile(means, 1 - a)), B: B, seed: seed, level: level };
  };

  /* ------------------------------------------------------------ the H-RADAR-01 holdout */
  /* followed bets -> the registered verdict. A criterion that cannot be
     evaluated is not met; passing makes Radar ELIGIBLE, a person promotes it */
  R.evaluateHoldout = function (gradedBets, rules) {
    rules = R.rules(rules);
    var all = gradedBets || [], excluded = {};
    var ex = function (k) { excluded[k] = (excluded[k] || 0) + 1; };
    var followed = all.filter(function (b) {
      if (b.settle == null) { ex(b.result === 'open' ? 'unresolved' : 'void'); return false; }
      if (b.follow5_price == null) { ex(b.follow5_reason || 'no_follow_price'); return false; }
      if (b.close_price == null) { ex('no_close'); return false; }
      return true;
    });
    var cl = function (b) { return b.event_ref || b.event_slug || b.condition_id; };
    var opt = { B: rules.bootstrap_resamples, seed: rules.bootstrap_seed, level: rules.ci_level };
    var beat = R.clusterBootstrap(followed.map(function (b) { return { cluster: cl(b), value: b.close_price > b.follow5_price ? 1 : 0 }; }), opt);
    var roi = R.clusterBootstrap(followed.map(function (b) { return { cluster: cl(b), value: b.follow5_roi }; }), opt);
    var f15 = all.filter(function (b) { return b.settle != null && b.follow15_price != null && b.close_price != null; });
    var slip = rules.follow_slippage_sensitivity;
    var C1 = followed.length >= rules.validation_min_followed;
    var C2 = beat.lo != null && beat.lo > 0.5;
    var C3 = roi.lo != null && roi.lo > 0;
    return {
      bets: all.length, followed: followed.length, excluded: excluded, games: beat.clusters,
      beat_close: { rate: beat.mean, lo: beat.lo, hi: beat.hi, n: beat.n },
      follow_roi: { mean: roi.mean, lo: roi.lo, hi: roi.hi, n: roi.n },
      criteria: [
        { id: 'C1_SAMPLE', met: C1, value: followed.length, threshold: rules.validation_min_followed },
        { id: 'C2_BEAT_CLOSE', met: C2, value: beat.lo, threshold: 0.5 },
        { id: 'C3_FOLLOW_ROI', met: C3, value: roi.lo, threshold: 0 }
      ],
      passed: C1 && C2 && C3,
      point_estimates_support_hypothesis: beat.mean != null && roi.mean != null && beat.mean > 0.5 && roi.mean > 0,
      secondary: {
        follow15: { n: f15.length, beat_close_rate: f15.length ? r4(f15.filter(function (b) { return b.close_price > b.follow15_price; }).length / f15.length) : null,
          follow_roi: f15.length ? r6(mean(f15.map(function (b) { return b.follow15_roi; }))) : null },
        plus_one_cent: { n: followed.length, follow_roi: followed.length ? r6(mean(followed.map(function (b) { var p = Math.min(0.99, b.follow5_price + slip); return b.settle / p - 1; }))) : null,
          beat_close_rate: followed.length ? r4(followed.filter(function (b) { return b.close_price > Math.min(0.99, b.follow5_price + slip); }).length / followed.length) : null },
        wallets_own: { roi: (function () { var c = followed.reduce(function (a, b) { return a + b.buy_cost; }, 0); return c > 0 ? r6(followed.reduce(function (a, b) { return a + b.profit; }, 0) / c) : null; }()),
          clv_pct: r6(mean(followed.map(function (b) { return b.clv_pct; }))) }
      }
    };
  };

  /* ------------------------------------------------------------ market matching
     A Polymarket game market -> EXACTLY ONE EdgeDesk game (signals.event_id):
     the same league, a start within kickoff_tolerance_min, and both of its
     outcomes resolving to the game's two teams one-to-one. Anything else
     stays unmapped with its reason: no nearest name, no nearest game. */
  function teamKey(s) {
    return String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/ st$/, ' state');
  }
  R.teamKey = teamKey;
  /* Polymarket names a club by its nickname ("Chiefs") or its school
     ("Alabama"); the board by its full name ("Kansas City Chiefs") */
  var ALIASES = { 'miami fl': 'miami hurricanes', 'miami oh': 'miami oh redhawks', 'miami ohio': 'miami oh redhawks', 'ole miss': 'ole miss rebels',
    'la rams': 'los angeles rams', 'la chargers': 'los angeles chargers', 'la clippers': 'los angeles clippers', 'la lakers': 'los angeles lakers',
    'ny giants': 'new york giants', 'ny jets': 'new york jets', 'ny knicks': 'new york knicks', 'ny rangers': 'new york rangers', 'ny islanders': 'new york islanders',
    'ny yankees': 'new york yankees', 'ny mets': 'new york mets', 'a s': 'athletics', 'oakland athletics': 'athletics' };
  R.teamScore = function (name, full) {
    var a = teamKey(name), b = teamKey(full);
    if (!a || !b) return 0;
    if (ALIASES[a]) a = ALIASES[a];
    if (ALIASES[b]) b = ALIASES[b];
    if (a === b) return 3;
    if (b.length > a.length && b.slice(-(a.length + 1)) === ' ' + a) return 2;              /* the nickname */
    if (b.length > a.length && b.slice(0, a.length + 1) === a + ' ') {                      /* the city or school, then a one- or two-word nickname */
      var rest = b.slice(a.length + 1).split(' ');
      return rest.length <= 2 ? 1 : 0;
    }
    return 0;
  };
  /* two outcomes against one game's two teams: the one assignment that works,
     preferring the stronger readings; two that work equally is ambiguous */
  function assign(names, home, away) {
    var s = [[R.teamScore(names[0], home), R.teamScore(names[0], away)], [R.teamScore(names[1], home), R.teamScore(names[1], away)]];
    var straight = s[0][0] > 0 && s[1][1] > 0 ? s[0][0] + s[1][1] : 0, swapped = s[0][1] > 0 && s[1][0] > 0 ? s[0][1] + s[1][0] : 0;
    if (!straight && !swapped) return null;
    if (straight === swapped) return { ambiguous: true };
    return straight > swapped ? { teams: [home, away], score: straight } : { teams: [away, home], score: swapped };
  }
  /* events: [{event_id, sport_key, home, away, commence_ms, sigs: [{sig_key, market, selection, point}]}] */
  R.matchMarket = function (m, events, rules, opts) {
    opts = opts || {};
    var tol = (opts.tolerance_min != null ? opts.tolerance_min : 360) * MIN;
    if (!m || !m.league || !R.LEAGUE_SPORT[m.league]) return { reason: 'league_not_covered' };
    if (rules && rules.leagues && rules.leagues.indexOf(m.league) < 0) return { reason: 'league_not_covered' };
    if (['moneyline', 'spreads', 'totals'].indexOf(m.market_type) < 0) return { reason: 'market_type_not_covered' };
    if (m.game_start_at == null) return { reason: 'no_start' };
    if ((m.outcomes || []).length !== 2 || (m.token_ids || []).length !== 2) return { reason: 'not_two_outcomes' };
    var sport = R.LEAGUE_SPORT[m.league];
    var near = (events || []).filter(function (e) { return e.sport_key === sport && e.commence_ms != null && Math.abs(e.commence_ms - m.game_start_at) <= tol; });
    if (!near.length) return { reason: 'no_event' };
    var teamsSrc = m.market_type === 'totals' ? null : m.outcomes;
    var cands = [];
    if (teamsSrc) {
      near.forEach(function (e) { var a = assign(teamsSrc, e.home, e.away); if (a) cands.push({ e: e, a: a }); });
      var clean = cands.filter(function (c) { return !c.a.ambiguous; });
      if (!cands.length) return { reason: 'team_unresolved', detail: { outcomes: m.outcomes, near: near.slice(0, 3).map(function (e) { return e.away + ' @ ' + e.home; }) } };
      if (!clean.length) return { reason: 'team_ambiguous', detail: { outcomes: m.outcomes } };
      if (clean.length > 1) return { reason: 'ambiguous_event', detail: { events: clean.map(function (c) { return c.e.event_id; }) } };
      cands = clean;
    } else {
      /* a total names no team: its event's title must (it "Chiefs vs. Raiders: O/U 47.5") */
      var title = String(m.event_title || m.question || '');
      var tm = /^(.+?)\s+(?:vs\.?|v\.?|@|at)\s+(.+?)(?::|\s+o\/u|\s+-|$)/i.exec(title.trim());
      if (!tm) return { reason: 'total_without_teams' };
      near.forEach(function (e) { var a = assign([tm[1], tm[2]], e.home, e.away); if (a && !a.ambiguous) cands.push({ e: e, a: a }); });
      if (!cands.length) return { reason: 'team_unresolved', detail: { title: title } };
      if (cands.length > 1) return { reason: 'ambiguous_event', detail: { events: cands.map(function (c) { return c.e.event_id; }) } };
    }
    var e = cands[0].e, a = cands[0].a;
    var sigOf = function (market, selection, point) {
      var hit = (e.sigs || []).filter(function (s) { return s.market === market && teamKey(s.selection) === teamKey(selection) && (point == null ? s.point == null : num(s.point) != null && Math.abs(num(s.point) - point) < 1e-9); });
      return hit.length === 1 ? hit[0].sig_key : null;
    };
    var sides;
    if (m.market_type === 'moneyline') {
      sides = [0, 1].map(function (i) { return { outcome_index: i, token_id: m.token_ids[i], outcome: m.outcomes[i], selection: a.teams[i], point: null, sig_key: sigOf('h2h', a.teams[i], null) }; });
    } else if (m.market_type === 'spreads') {
      var q = String(m.question || ''), mm = /\(([+-]?\d+(?:\.\d+)?)\)/.exec(q), qp = mm ? num(mm[1]) : null;
      var named = qp != null ? q.replace(/\(.*$/, '').replace(/^[^:]*:\s*/, '').trim() : null;
      var base = qp != null ? qp : m.line;
      if (base == null) return { reason: 'spread_without_line' };
      /* the line belongs to the team the question names; without a name, to the first outcome */
      var owner = 0;
      if (named) {
        var s0 = R.teamScore(named, a.teams[0]), s1 = R.teamScore(named, a.teams[1]);
        if (s0 === s1) return { reason: 'spread_owner_unclear', detail: { question: q } };
        owner = s0 > s1 ? 0 : 1;
      }
      sides = [0, 1].map(function (i) { var p = i === owner ? base : -base; return { outcome_index: i, token_id: m.token_ids[i], outcome: m.outcomes[i], selection: a.teams[i], point: p, sig_key: sigOf('spreads', a.teams[i], p) }; });
    } else {
      var ln = m.line;
      if (ln == null) { var tq = /(\d+(?:\.\d+)?)\s*$/.exec(String(m.question || '')); ln = tq ? num(tq[1]) : null; }
      if (ln == null) return { reason: 'total_without_line' };
      var ov = m.outcomes.map(function (o) { return teamKey(o); });
      if (!(ov.indexOf('over') >= 0 && ov.indexOf('under') >= 0)) return { reason: 'total_outcomes_not_over_under' };
      sides = [0, 1].map(function (i) { var sel = ov[i] === 'over' ? 'Over' : 'Under'; return { outcome_index: i, token_id: m.token_ids[i], outcome: m.outcomes[i], selection: sel, point: ln, sig_key: sigOf('totals', sel, ln) }; });
    }
    return { event_id: e.event_id, sport_key: e.sport_key, home: e.home, away: e.away, commence_ms: e.commence_ms,
      kickoff_gap_min: Math.round(Math.abs(e.commence_ms - m.game_start_at) / MIN), sides: sides,
      confidence: a.score >= 4 ? 'high' : 'medium', method: 'teams:' + a.score + ';start<=' + Math.round(tol / MIN) + 'm', linker_version: R.LINKER_VERSION };
  };

  return R;
}));
// ── END RADAR CORE ──
// ── BEGIN RADAR GATEWAY ── copied from lib/edgedesk_poly_gateway.js by tools/radar/inline_core.js; do not edit here
/* ===========================================================================
   EdgeDesk PREDICTION RADAR — the Polymarket gateway. The ONLY Radar client
   of Polymarket's public APIs. docs/prediction-radar.md §Data sources

   The pattern of supabase/functions/odds_gateway (one door, a budget, a
   bounded backoff, fail closed), for a source that costs nothing but has
   rate limits and no stability guarantee:

     1 THE SWITCH. POLYMARKET_DATA_ENABLED must be on, or nothing is asked.
       The scheduled job reads it from public.radar_config at the start of
       every run (so it is turned off with one SQL statement, no deploy) and
       from the function's own environment; both must say on.
     2 THE BUDGET. Every attempt, retries included, takes one request from a
       budget the caller hands in. The scheduled job's budget is the grant of
       public.poly_api_acquire() (a daily ceiling and a per-run cap, decided
       under one row lock); the validation runner's is a fixed count.
       An empty budget is a refusal, never a wait.
     3 THE PACE. Requests to one host start at least pace_ms apart, whatever
       the concurrency.
     4 THE BACKOFF. No answer, a timeout, a 429 or a 5xx is retried at most
       max_retries times, base 1 s doubling, jittered +-20%, capped at 16 s; a
       429's Retry-After is honoured up to 60 s. Any other 4xx is not retried.
     5 THE BREAKER. breaker_after consecutive 429s or 5xx open it for the
       rest of the run: every later request is refused without being sent.
     6 THE ENDPOINTS. Only the paths in ENDPOINTS can be asked for. The P&L
       and rankings hosts are not here: they carry no stability guarantee, so
       Radar computes P&L itself from trades (lib/edgedesk_radar.js).
   tools/radar/no_bypass.test.js fails the build if any other Radar file
   names a Polymarket host.

   Node: require('./edgedesk_poly_gateway.js'). Deno (the edge function): a
   verbatim copy between BEGIN/END RADAR GATEWAY markers.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EDPolyGateway = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var G = { VERSION: 'edgedesk_poly_gateway/1' };

  G.HOSTS = { data: 'https://data-api.polymarket.com', gamma: 'https://gamma-api.polymarket.com', clob: 'https://clob.polymarket.com' };
  G.ENDPOINTS = {
    leaderboard: { host: 'data', path: '/v1/leaderboard' },      /* the candidate pool (category SPORTS) */
    activity: { host: 'data', path: '/v2/activity' },            /* a wallet's trades, redemptions, splits, merges */
    positions: { host: 'data', path: '/v2/positions' },          /* a wallet's positions by status */
    holders: { host: 'data', path: '/v2/holders' },              /* who holds each side of one market */
    holders_v1: { host: 'data', path: '/holders' },              /* the documented v1 holders list (the probe compares the two) */
    sports: { host: 'gamma', path: '/sports' },                  /* the leagues and their series */
    events: { host: 'gamma', path: '/events' },                  /* game events and their markets */
    markets: { host: 'gamma', path: '/markets' },                /* market metadata, by condition id */
    prices_history: { host: 'clob', path: '/prices-history' },   /* one outcome token's price over time */
    book: { host: 'clob', path: '/book' },                       /* one outcome token's order book now: the ask a follower pays */
    price: { host: 'clob', path: '/price' },                     /* one outcome token's best price now, on one side */
    midpoint: { host: 'clob', path: '/midpoint' },               /* one outcome token's midpoint now */
    fee_rate: { host: 'clob', path: '/fee-rate' }                /* one outcome token's fee rate */
  };
  G.DEFAULTS = { pace_ms: { data: 120, gamma: 80, clob: 120 }, max_retries: 3, timeout_ms: 20000, backoff_base_ms: 1000, backoff_cap_ms: 16000,
    retry_after_cap_ms: 60000, breaker_after: 6, user_agent: 'EdgeDesk Prediction Radar (+https://edgedesksports.com/radar/)' };

  /* the URL for one endpoint: arrays repeat their key (condition_ids=a&condition_ids=b) */
  G.url = function (endpoint, params, bases) {
    var e = G.ENDPOINTS[endpoint];
    if (!e) throw new Error('poly gateway: unknown endpoint ' + endpoint + ' (only ' + Object.keys(G.ENDPOINTS).join(', ') + ')');
    var base = ((bases && bases[e.host]) || G.HOSTS[e.host]).replace(/\/$/, '');
    var q = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v === undefined || v === null || v === '') return;
      (Array.isArray(v) ? v : [v]).forEach(function (x) { q.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(x))); });
    });
    return base + e.path + (q.length ? '?' + q.join('&') : '');
  };

  /* temporary failures: no answer, a timeout, a rate limit, the server's own 5xx */
  G.retryable = function (status, timedOut) { return !!timedOut || status === 0 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504; };
  /* backoff before retry n (1-based); a 429's Retry-After (seconds) wins when longer */
  G.backoffMs = function (n, retryAfterS, rnd, o) {
    o = o || G.DEFAULTS; rnd = rnd || Math.random;
    var raw = Math.min(o.backoff_cap_ms, o.backoff_base_ms * Math.pow(2, Math.max(0, n - 1)));
    var b = Math.round(Math.min(o.backoff_cap_ms, raw * (0.8 + 0.4 * rnd())));
    var ra = Number(retryAfterS);
    if (isFinite(ra) && ra > 0) b = Math.max(b, Math.min(o.retry_after_cap_ms, Math.round(ra * 1000)));
    return b;
  };

  /* a fixed budget (the validation runner): take() is true until it is spent */
  G.fixedBudget = function (limit) {
    var used = 0;
    return { limit: limit, take: function () { if (used >= limit) return false; used++; return true; }, get used() { return used; } };
  };

  /* opts: fetch, sleep, now, rnd, enabled (boolean or () => boolean), budget
     ({take()}), bases (tests), and any of DEFAULTS */
  G.make = function (opts) {
    opts = opts || {};
    var o = {};
    Object.keys(G.DEFAULTS).forEach(function (k) { o[k] = opts[k] != null ? opts[k] : G.DEFAULTS[k]; });
    if (opts.pace_ms) o.pace_ms = Object.assign({}, G.DEFAULTS.pace_ms, opts.pace_ms);
    var doFetch = opts.fetch || (typeof fetch === 'function' ? fetch : null);
    var sleep = opts.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var now = opts.now || function () { return Date.now(); };
    var rnd = opts.rnd || Math.random;
    var budget = opts.budget || null;
    var nextAt = {}, consecutive = 0, breaker = false;
    var stats = { requests: 0, ok: 0, retries: 0, refused: {}, statuses: {}, by_endpoint: {}, breaker: false, rate_limited: 0 };
    var refuse = function (decision, reason, url) { stats.refused[decision] = (stats.refused[decision] || 0) + 1; return { ok: false, status: 0, data: null, attempts: 0, decision: decision, reason: reason, url: url }; };
    var enabled = function () { return typeof opts.enabled === 'function' ? !!opts.enabled() : opts.enabled === true; };
    function deadline(ms) { try { return AbortSignal.timeout(ms); } catch (_) { return undefined; } }

    async function pace(host) {
      var t = now(), slot = Math.max(t, nextAt[host] || 0);
      nextAt[host] = slot + (o.pace_ms[host] || 0);
      if (slot > t) await sleep(slot - t);
    }

    async function get(endpoint, params) {
      var url = G.url(endpoint, params, opts.bases);
      if (!enabled()) return refuse('disabled', 'POLYMARKET_DATA_ENABLED is off: nothing was asked', url);
      if (!doFetch) return refuse('no_fetch', 'no fetch in this runtime', url);
      var host = G.ENDPOINTS[endpoint].host;
      stats.by_endpoint[endpoint] = (stats.by_endpoint[endpoint] || 0) + 1;
      for (var attempt = 1; ; attempt++) {
        if (breaker) return refuse('breaker_open', 'the breaker opened after ' + o.breaker_after + ' consecutive rate limits or server errors: nothing more this run', url);
        if (budget && !(await budget.take())) return refuse('budget_exhausted', 'the request budget for this run is spent', url);
        await pace(host);
        stats.requests++;
        var status = 0, text = '', timedOut = false, retryAfter = null;
        try {
          var r = await doFetch(url, { method: 'GET', headers: { accept: 'application/json', 'user-agent': o.user_agent }, signal: deadline(o.timeout_ms) });
          status = r.status;
          retryAfter = r.headers && r.headers.get ? r.headers.get('retry-after') : null;
          text = String((await r.text()) || '');
        } catch (e) {
          var name = String((e && e.name) || '');
          timedOut = name === 'TimeoutError' || name === 'AbortError';
          text = (timedOut ? 'timeout after ' + o.timeout_ms + ' ms: ' : 'network: ') + String((e && e.message) || e).slice(0, 200);
        }
        stats.statuses[status] = (stats.statuses[status] || 0) + 1;
        if (status >= 200 && status < 300) {
          var data;
          try { data = text ? JSON.parse(text) : null; } catch (_) {
            consecutive = 0;
            return { ok: false, status: status, data: null, attempts: attempt, decision: 'malformed', reason: 'the answer was not JSON: ' + text.slice(0, 120), url: url };
          }
          consecutive = 0; stats.ok++;
          return { ok: true, status: status, data: data, attempts: attempt, decision: 'ok', reason: null, url: url };
        }
        if (status === 429) stats.rate_limited++;
        if (!G.retryable(status, timedOut)) {
          consecutive = 0;
          return { ok: false, status: status, data: null, attempts: attempt, decision: status ? 'http_' + status : 'unreachable', reason: text.slice(0, 240), url: url };
        }
        consecutive++;
        if (consecutive >= o.breaker_after) { breaker = true; stats.breaker = true; }
        if (attempt > o.max_retries || breaker) {
          return { ok: false, status: status, data: null, attempts: attempt, decision: breaker ? 'breaker_open' : (timedOut ? 'timeout' : status ? 'http_' + status : 'unreachable'), reason: text.slice(0, 240), url: url };
        }
        stats.retries++;
        await sleep(G.backoffMs(attempt, status === 429 ? retryAfter : null, rnd, o));
      }
    }
    return { get: get, stats: function () { return JSON.parse(JSON.stringify(stats)); }, options: o };
  };

  return G;
}));
// ── END RADAR GATEWAY ──

const R: any = (globalThis as any).EDRadar;
const G: any = (globalThis as any).EDPolyGateway;
const env = (k: string) => ((globalThis as any).Deno?.env?.get(k) ?? "").trim();
const msg = (e: unknown) => String((e as any)?.message ?? e).slice(0, 300);
const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
function deadline(ms: number) { try { return (AbortSignal as any).timeout(ms); } catch { return undefined; } }
const H = 3600e3, MIN = 60e3, DAY = 864e5;
/* the run's budget: requests it asks poly_api_acquire for, by mode */
export const ASK: Record<string, number> = { tonight: 400, pool: 20, wallets: 900, grade: 0 };
const WALLETS_PER_RUN = 3;
/* a wallets run must answer within Supabase's 150 s request limit (production's
   first one, three new wallets, did not: HTTP 504). After WALLETS_TIME_MS it
   starts no new wallet, activity page or graded bet; a wallet it did not finish
   stays due with its place kept, and the next run carries on from there */
const WALLETS_TIME_MS = 75000;
/* and holds at most WALLET_PAGES_PER_RUN activity pages (1,000 rows each) at once: a production run with a
   whole 30-page history ran out of compute (HTTP 546). The 30-page cap still counts across runs */
const WALLET_PAGES_PER_RUN = 10;
/* a run that dies part way (out of compute, HTTP 546: production, 2026-10-29 16:38 UTC) cannot record anything,
   so each wallet is marked (attempt_at, attempts) BEFORE its work and the mark cleared when its work ends. A
   marked wallet is in another run or killed one: it is set aside for ATTEMPT_COOLDOWN_MS, and after
   MAX_ATTEMPTS marks only read once a day, so one wallet never blocks the pool behind it */
const ATTEMPT_COOLDOWN_MS = 15 * 60e3, MAX_ATTEMPTS = 3, DUE_LOOKAHEAD = 20;
/* what Polymarket accepts (radar-sources run 40812803914): /v2/holders answers
   at most 100 holders a side with include_pnl (500 is refused, HTTP 400), and
   one unwindowed page of 100 open NFL events was 48 MB, so events are asked
   in a window on their end date (a game event's end date is its start),
   EVENTS_PER_PAGE at a time, at most EVENT_PAGES pages a series */
const HOLDERS_LIMIT = 100, EVENTS_PER_PAGE = 5, EVENT_PAGES = 16;

/* tests stand in for the clock between retries, and for the run's own clock */
export const hooks: any = { sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now() };

/* ---------------------------------------------------------------- the database (PostgREST, service role) */
async function db(path: string, init?: any): Promise<any> {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const r = await fetch(env("SUPABASE_URL").replace(/\/$/, "") + "/rest/v1/" + path, {
    ...init, signal: deadline(20000),
    headers: { apikey: key, authorization: "Bearer " + key, "content-type": "application/json", ...((init && init.headers) || {}) },
  });
  const t = await r.text();
  if (!r.ok) { const e: any = new Error("db " + r.status + " " + path.split("?")[0] + ": " + t.slice(0, 300)); e.status = r.status; throw e; }
  return t ? JSON.parse(t) : null;
}
const rpc = (fn: string, args: any) => db("rpc/" + fn, { method: "POST", body: JSON.stringify(args || {}) });
const insert = (table: string, rows: any) => db(table, { method: "POST", body: JSON.stringify(rows), headers: { prefer: "return=minimal" } });
const insertOnce = (table: string, rows: any, key: string) =>
  db(table + "?on_conflict=" + key, { method: "POST", body: JSON.stringify(rows), headers: { prefer: "return=minimal,resolution=ignore-duplicates" } });
const upsert = (table: string, rows: any, key: string) =>
  db(table + "?on_conflict=" + key, { method: "POST", body: JSON.stringify(rows), headers: { prefer: "return=minimal,resolution=merge-duplicates" } });
const patch = (path: string, body: any) => db(path, { method: "PATCH", body: JSON.stringify(body), headers: { prefer: "return=minimal" } });
async function dbAll(path: string, pages = 50): Promise<any[]> {
  const out: any[] = [];
  for (let p = 0; p < pages; p++) {
    const rows = (await db(path + (path.includes("?") ? "&" : "?") + "limit=1000&offset=" + p * 1000)) || [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
async function inChunks(rows: any[], n: number, fn: (c: any[]) => Promise<any>) { for (let i = 0; i < rows.length; i += n) await fn(rows.slice(i, i + n)); }
const inList = (xs: string[]) => "(" + xs.map((x) => '"' + String(x).replace(/"/g, '\\"') + '"').join(",") + ")";

/* ---------------------------------------------------------------- shapes for the database */
function marketRecord(m: any, withSettle: boolean) {
  const r: any = {
    condition_id: m.condition_id, market_id: m.market_id, question: m.question, slug: m.slug, event_slug: m.event_slug, event_ref: m.event_ref,
    event_title: m.event_title, league: m.league, market_type: m.market_type, type_source: m.type_source, line: m.line,
    outcomes: m.outcomes, token_ids: m.token_ids, game_start_at: iso(m.game_start_at), closed: !!m.closed,
  };
  if (withSettle) { r.settle = m.settle; r.resolved_at = m.settle ? new Date().toISOString() : null; }
  return r;
}
function tradeRecord(t: any, m: any, runId: string) {
  const oi = t.outcome_index != null ? t.outcome_index : (m && t.token_id ? m.token_ids.indexOf(String(t.token_id)) : null);
  return { wallet: t.wallet, kind: t.kind, side: t.side, condition_id: t.condition_id, token_id: t.token_id, outcome_index: oi != null && oi >= 0 ? oi : null,
    size: t.size, price: t.price, usdc: t.usdc, traded_at: iso(t.ts), tx_hash: t.tx_hash, slug: t.slug, event_slug: t.event_slug, run_id: runId };
}
function betRecord(b: any, runId: string) {
  return {
    wallet: b.wallet, token_id: b.token_id, condition_id: b.condition_id, outcome_index: b.outcome_index, outcome: b.outcome, league: b.league,
    market_type: b.market_type, line: b.line, event_ref: b.event_ref, event_slug: b.event_slug, question: b.question, game_start_at: iso(b.game_start_at),
    entry_at: iso(b.entry_at), entry_tx: b.entry_tx, txs: b.txs, entry_price: b.entry_price, stake: b.stake, shares_pregame: b.shares_pregame, buy_cost: b.buy_cost,
    sell_proceeds: b.sell_proceeds, shares_held: b.shares_held, trades: b.trades, settle: b.settle, result: b.result, profit: b.profit,
    close_price: b.close_price, close_at: iso(b.close_at), clv_pp: b.clv_pp, clv_pct: b.clv_pct,
    follow5_price: b.follow5_price, follow5_at: iso(b.follow5_at), follow5_reason: b.follow5_reason, follow5_roi: b.follow5_roi,
    follow15_price: b.follow15_price, follow15_at: iso(b.follow15_at), follow15_reason: b.follow15_reason, follow15_roi: b.follow15_roi,
    beat_close5: b.beat_close5, grading_version: R.GRADING_VERSION, run_id: runId,
  };
}
/* a stored market row read back into the core's shape */
function fromStored(m: any) {
  return { condition_id: m.condition_id, question: m.question, slug: m.slug, event_slug: m.event_slug, event_ref: m.event_ref, event_title: m.event_title,
    league: m.league, market_type: m.market_type, line: m.line == null ? null : Number(m.line), outcomes: m.outcomes || [], token_ids: (m.token_ids || []).map(String),
    game_start_at: R.ms(m.game_start_at), closed: !!m.closed, settle: m.settle || null };
}
function tradeFromStored(t: any) {
  return { wallet: t.wallet, kind: t.kind, side: t.side, condition_id: t.condition_id, token_id: t.token_id, outcome_index: t.outcome_index,
    size: t.size == null ? null : Number(t.size), price: t.price == null ? null : Number(t.price), ts: R.ms(t.traded_at), tx_hash: t.tx_hash };
}

/* ---------------------------------------------------------------- Polymarket, through the gateway */
async function ask(ctx: any, endpoint: string, params: any) {
  const r = await ctx.gw.get(endpoint, params);
  if (!r.ok) {
    ctx.failedRequests++;
    if (ctx.failedRequests <= 5 || r.decision === "budget_exhausted" || r.decision === "breaker_open") ctx.alert("DEGRADED", "poly_" + r.decision, endpoint + " " + r.decision + (r.reason ? ": " + String(r.reason).slice(0, 160) : ""), { url: r.url });
  }
  return r;
}
async function leagueSeries(ctx: any): Promise<Record<string, string[]>> {
  const r = await ask(ctx, "sports", {});
  const out: Record<string, string[]> = {};
  if (!r.ok) return out;
  const alias: Record<string, string> = { nfl: "nfl", cfb: "cfb", ncaaf: "cfb", nba: "nba", nhl: "nhl", mlb: "mlb" };
  for (const s of R.page(r.data).rows) {
    const lg = alias[String(s.sport || s.slug || "").toLowerCase()];
    if (!lg || ctx.rules.leagues.indexOf(lg) < 0) continue;
    const ids = String(s.series || "").split(",").map((x: string) => x.trim()).filter(Boolean);
    if (ids.length) out[lg] = (out[lg] || []).concat(ids);
  }
  if (!Object.keys(out).length) ctx.alert("DRIFT", "no_league_series", "Gamma /sports named no series for the covered leagues: nothing to discover");
  return out;
}

/* ---------------------------------------------------------------- tonight */
async function tonight(ctx: any) {
  const now = ctx.nowMs, rules = ctx.rules;
  const horizon = now + rules.upcoming_hours * H;
  /* 1. the covered leagues' open game events in the window, and their markets */
  const series = await leagueSeries(ctx);
  const seen: Record<string, any> = {};
  const from = iso(now - 6 * H)!, to = iso(horizon + DAY)!;
  for (const lg of Object.keys(series)) {
    for (const sid of series[lg].slice(0, 2)) {
      for (let page = 0; page < EVENT_PAGES; page++) {
        const r = await ask(ctx, "events", { series_id: sid, closed: false, end_date_min: from, end_date_max: to, limit: EVENTS_PER_PAGE, offset: page * EVENTS_PER_PAGE });
        if (!r.ok) break;
        const rows = R.page(r.data).rows;
        for (const e of rows) for (const m of e.markets || []) {
          const x = R.marketRow(m, e);
          if (!x) { ctx.drift++; continue; }
          if (!R.covered(x, rules) || x.game_start_at == null) continue;
          if (x.game_start_at < now - 6 * H || x.game_start_at > horizon + DAY) continue;
          seen[x.condition_id] = x;
        }
        if (rows.length < EVENTS_PER_PAGE) break;
        if (page === EVENT_PAGES - 1) ctx.alert("WARNING", "events_capped", lg + " series " + sid + ": more than " + EVENT_PAGES * EVENTS_PER_PAGE + " open events in the window; the rest were not read");
      }
    }
  }
  const markets = Object.values(seen);
  ctx.run.details.markets_seen = markets.length;
  if (ctx.drift) ctx.alert("DRIFT", "market_unreadable", ctx.drift + " Gamma market(s) could not be read (no condition id)");
  if (!ctx.dry && markets.length) await inChunks(markets.map((m: any) => marketRecord(m, false)), 200, (c) => upsert("poly_markets", c, "condition_id"));

  /* 2. match each pending market to ONE EdgeDesk game */
  /* 100 ids a lookup, as everywhere else here: a night's full slate in one URL
     is longer than fetch takes (65,534 bytes), and it refuses it "Invalid URL" */
  const ids = markets.map((m: any) => m.condition_id);
  const stored: any[] = [];
  await inChunks(ids, 100, async (c) => { stored.push(...(await dbAll("poly_markets?select=condition_id,event_id,match_status,sides,game_start_at&condition_id=in." + inList(c)))); });
  const byId: Record<string, any> = {};
  for (const s of stored) byId[s.condition_id] = s;
  const pending = markets.filter((m: any) => !byId[m.condition_id] || !byId[m.condition_id].event_id);
  let mapped = 0;
  const unmapped: any[] = [];
  if (pending.length) {
    const sports = Array.from(new Set(pending.map((m: any) => R.LEAGUE_SPORT[m.league]).filter(Boolean)));
    const tol = rules.kickoff_tolerance_min * MIN;
    const rows = await dbAll("signals?select=sig_key,event_id,sport_key,commence_time,home_team,away_team,market,selection,point&market=in.(h2h,spreads,totals)"
      + "&sport_key=in.(" + sports.join(",") + ")&commence_time=gte." + encodeURIComponent(iso(now - 6 * H - tol)!) + "&commence_time=lte." + encodeURIComponent(iso(horizon + DAY + tol)!) + "&order=event_id");
    const evs: Record<string, any> = {};
    for (const s of rows) {
      if (!s.event_id || !s.home_team || !s.away_team) continue;
      const e = evs[s.event_id] = evs[s.event_id] || { event_id: s.event_id, sport_key: s.sport_key, home: s.home_team, away: s.away_team, commence_ms: R.ms(s.commence_time), sigs: [] };
      e.sigs.push({ sig_key: s.sig_key, market: s.market, selection: s.selection, point: s.point });
    }
    const events = Object.values(evs);
    for (const m of pending) {
      const r = R.matchMarket(m, events, rules, { tolerance_min: rules.kickoff_tolerance_min });
      if (r.event_id) {
        mapped++;
        if (!ctx.dry) await patch("poly_markets?condition_id=eq." + m.condition_id + "&event_id=is.null", {
          event_id: r.event_id, sport_key: r.sport_key, sides: r.sides, match_status: "mapped", match_reason: null, match_detail: { kickoff_gap_min: r.kickoff_gap_min, home: r.home, away: r.away },
          match_confidence: r.confidence, match_method: r.method, matched_at: iso(now), linker_version: R.LINKER_VERSION });
        byId[m.condition_id] = { condition_id: m.condition_id, event_id: r.event_id, sides: r.sides, game_start_at: iso(m.game_start_at) };
      } else {
        unmapped.push({ condition_id: m.condition_id, question: m.question, reason: r.reason, start: iso(m.game_start_at) });
        if (!ctx.dry) await patch("poly_markets?condition_id=eq." + m.condition_id + "&event_id=is.null", { match_status: "pending", match_reason: r.reason, match_detail: r.detail ?? null });
      }
    }
  }
  ctx.run.details.mapped_new = mapped;
  ctx.run.details.unmapped = unmapped.length;
  ctx.out.unmapped = unmapped.slice(0, 40);
  const soon = unmapped.filter((u: any) => R.ms(u.start) != null && R.ms(u.start)! - now <= 12 * H && u.reason !== "no_event");
  if (soon.length) ctx.alert("WARNING", "unmapped_markets", soon.length + " Polymarket game market(s) starting within 12 hours could not be matched to one EdgeDesk game: "
    + soon.slice(0, 5).map((u: any) => (u.question || u.condition_id) + " (" + u.reason + ")").join("; "), { markets: soon.slice(0, 20) });

  /* 3. holders and prices of the matched markets of upcoming games, at the
     board's own lines: an alternate line has no EdgeDesk fair to compare with */
  const upcoming = markets.filter((m: any) => byId[m.condition_id] && byId[m.condition_id].event_id && m.game_start_at > now && m.game_start_at <= horizon);
  const live = upcoming.filter((m: any) => (byId[m.condition_id].sides || []).some((s: any) => s && s.sig_key));
  ctx.run.details.markets_live = live.length;
  ctx.run.details.markets_alt_lines = upcoming.length - live.length;
  const pool = new Set((await dbAll("poly_wallets?select=wallet&in_pool=is.true")).map((w: any) => w.wallet));
  const at = iso(now)!;
  const holders: any[] = [], prices: any[] = [], names: Record<string, any> = {};
  for (const m of live) {
    m.last_prices && m.last_prices.forEach((p: any, i: number) => { if (p != null) prices.push({ run_id: ctx.run.run_id, captured_at: at, condition_id: m.condition_id, token_id: m.token_ids[i], outcome_index: i, price: p, source: "gamma_outcome_prices" }); });
    const r = await ask(ctx, "holders", { condition: m.condition_id, include_pnl: true, limit: HOLDERS_LIMIT });
    if (!r.ok) continue;
    const rows = R.holderRows(r.data, m.condition_id);
    if (!rows.length) ctx.drift++;
    for (const h of rows) {
      if (!pool.has(h.wallet)) continue;
      const oi = h.outcome_index != null ? h.outcome_index : m.token_ids.indexOf(String(h.token_id));
      if (oi == null || oi < 0) continue;
      holders.push({ run_id: ctx.run.run_id, captured_at: at, condition_id: m.condition_id, token_id: m.token_ids[oi], outcome_index: oi, wallet: h.wallet,
        shares: h.shares, avg_price: h.avg_price, cost: h.cost, pnl: h.pnl });
      names[h.wallet] = { wallet: h.wallet, display_public: !!h.display_public, display_name: h.display_public ? (h.name || null) : null, updated_at: at };
    }
  }
  ctx.run.details.holders = holders.length;
  ctx.run.details.prices = prices.length;
  if (!ctx.dry) {
    await inChunks(holders, 500, (c) => insertOnce("poly_holder_snapshots", c, "run_id,condition_id,token_id,wallet"));
    await inChunks(prices, 500, (c) => insertOnce("poly_price_snapshots", c, "run_id,token_id"));
    await inChunks(Object.values(names), 200, (c) => upsert("poly_wallets", c, "wallet"));
  }

  /* 4. the resolution of matched markets whose game started in the last two days */
  const done = await dbAll("poly_markets?select=condition_id&event_id=not.is.null&settle=is.null&game_start_at=lt." + encodeURIComponent(at)
    + "&game_start_at=gt." + encodeURIComponent(iso(now - 2 * DAY)!) + "&order=game_start_at");
  await resolveMarkets(ctx, done.map((d: any) => d.condition_id));

  /* 5. the Radar record (supabase/radar_record.sql): every card subscribers now see is published once,
     at the price a follower could take now; every started one is graded once */
  if (!ctx.dry) {
    try {
      ctx.run.details.cards_published = await rpc("radar_publish_cards", {});
      ctx.run.details.cards_graded = await rpc("radar_grade_cards", {});
    } catch (e) {
      if ((e as any).status === 404 || /PGRST202|Could not find the function|does not exist/.test(msg(e))) ctx.alert("WARNING", "record_not_installed", "supabase/radar_record.sql is not applied: Smart Money Tonight is not being recorded");
      else throw e;
    }
  }
}

/* Gamma by condition id, 50 a call. Gamma answers a resolved market only when
   asked with closed=true, and an open one only without it (radar-sources run
   40811733314), so the closed ones are asked first and, unless only resolved
   markets are wanted, the rest after */
async function gammaMarkets(ctx: any, ids: string[], resolvedOnly: boolean) {
  const out: Record<string, any> = {};
  for (const closed of resolvedOnly ? [true] : [true, false]) {
    const left = ids.filter((c) => !out[c]);
    for (let i = 0; i < left.length; i += 50) {
      const r = await ask(ctx, "markets", { condition_ids: left.slice(i, i + 50), closed, limit: 50 });
      if (!r.ok) continue;
      for (const raw of R.page(r.data).rows) { const m = R.marketRow(raw); if (m) out[m.condition_id] = m; }
    }
  }
  return out;
}

/* a resolved market gets its settlement once */
async function resolveMarkets(ctx: any, ids: string[]) {
  let resolved = 0;
  for (const m of Object.values(await gammaMarkets(ctx, ids, true)) as any[]) {
    if (!m.settle) continue;
    if (!ctx.dry) await patch("poly_markets?condition_id=eq." + m.condition_id + "&settle=is.null", { settle: m.settle, closed: true, resolved_at: iso(ctx.nowMs) });
    resolved++;
  }
  ctx.run.details.resolved = (ctx.run.details.resolved || 0) + resolved;
}

/* ---------------------------------------------------------------- pool */
async function pool(ctx: any) {
  const rules = ctx.rules, at = iso(ctx.nowMs)!;
  const out: any[] = [];
  for (let off = 0; off < rules.pool_size; off += 50) {
    const r = await ask(ctx, "leaderboard", { category: "SPORTS", timePeriod: rules.pool_period, orderBy: rules.pool_order, limit: 50, offset: off });
    if (!r.ok) break;
    const rows = R.page(r.data).rows.map(R.leaderRow).filter(Boolean);
    if (!rows.length) break;
    out.push(...rows);
  }
  const top = out.slice(0, rules.pool_size);
  ctx.run.details.pool = top.length;
  if (!top.length) { ctx.alert("FAILURE", "pool_empty", "the sports leaderboard named no wallet: the pool is unchanged"); return; }
  if (ctx.dry) { ctx.out.pool = top.slice(0, 10); return; }
  await inChunks(top.map((w: any, i: number) => ({ wallet: w.wallet, in_pool: true, pool_rank: i + 1, pool_volume: w.volume, pool_pnl: w.pnl, pool_refreshed_at: at, updated_at: at })),
    200, (c) => upsert("poly_wallets", c, "wallet"));
  /* every wallet this read did not name leaves the pool (its grades and history stay) */
  await patch("poly_wallets?in_pool=is.true&or=(pool_refreshed_at.is.null,pool_refreshed_at.lt." + encodeURIComponent(at) + ")", { in_pool: false, updated_at: at });
}

/* ---------------------------------------------------------------- wallets */
async function wallets(ctx: any) {
  const rules = ctx.rules, now = ctx.nowMs;
  const listed = await db("poly_wallets?select=wallet,activity_cursor,history_truncated&in_pool=is.true&or=(activity_synced_at.is.null,activity_synced_at.lt."
    + encodeURIComponent(iso(now - 20 * H)!) + ")&order=activity_synced_at.asc.nullsfirst,pool_rank.asc&limit=" + DUE_LOOKAHEAD);
  const skipped: string[] = [];
  const due = (listed || []).filter((w: any) => {
    const c = w.activity_cursor || {}, at = c.attempt_at ? R.ms(c.attempt_at) : null;
    if (at == null || !(now - at < ATTEMPT_COOLDOWN_MS || (Number(c.attempts || 0) >= MAX_ATTEMPTS && now - at < DAY))) return true;
    skipped.push(w.wallet);
    return false;
  }).slice(0, WALLETS_PER_RUN);
  if (skipped.length) {
    ctx.run.details.skipped = skipped;
    ctx.alert("WARNING", "wallet_skipped", skipped.length + " wallet(s) set aside: a run died part way through them (each is read again later)", { wallets: skipped });
  }
  const late = () => hooks.now() - ctx.t0 > WALLETS_TIME_MS;
  ctx.run.details.wallets = [];
  for (const w of due || []) {
    if (late()) { ctx.run.details.time_up = true; break; }
    const d: any = { wallet: w.wallet };
    ctx.run.details.wallets.push(d);
    /* 1. activity since the cursor (the window's start the first time). A first read cut by time keeps
       first_pages in the cursor, so the next run carries on and the page cap counts both */
    const cur = w.activity_cursor || {};
    /* the attempt mark, before any work: if this run dies, the next one sets this wallet aside */
    if (!ctx.dry) await patch("poly_wallets?wallet=eq." + w.wallet, { activity_cursor: Object.assign({}, cur, { attempt_at: iso(now), attempts: Number(cur.attempts || 0) + 1 }), updated_at: iso(now) });
    const first = cur.ts_s == null || cur.first_pages != null, before = first ? Number(cur.first_pages || 0) : 0;
    let start = cur.ts_s == null ? Math.floor((now - 400 * DAY) / 1000) : Math.max(1, cur.ts_s - 1), cursor: any = null, pages = 0, last = cur.ts_s || null, truncated = !!w.history_truncated, ok = true, actCut = false;
    const rows: any[] = [];
    for (;;) {
      if (pages > 0 && late()) { actCut = true; break; }
      const r = await ask(ctx, "activity", { user: w.wallet, type: "TRADE,REDEEM,SPLIT,MERGE", limit: 1000, sort_direction: "ASC", start, cursor });
      if (!r.ok) { ok = false; break; }
      pages++;
      const pg = R.page(r.data);
      for (const a of pg.rows) { const x = R.activityRow(a, w.wallet); if (x) rows.push(x); else ctx.drift++; }
      if (!pg.has_more) break;
      if (before + pages >= rules.wallet_max_pages) { if (first) truncated = true; break; }
      if (pages >= WALLET_PAGES_PER_RUN) { actCut = true; break; }
      cursor = pg.next_cursor;
    }
    d.pages = pages; d.rows = rows.length; d.truncated = truncated;
    if (!ok) { d.status = "activity_failed"; if (!ctx.dry) await patch("poly_wallets?wallet=eq." + w.wallet, { activity_cursor: cur, updated_at: iso(now) }); continue; }
    /* 2. the markets: the new ones, and stored ones not resolved yet */
    const conds = Array.from(new Set(rows.map((t: any) => t.condition_id)));
    const known: Record<string, any> = {};
    await inChunks(conds, 100, async (c) => { for (const m of await dbAll("poly_markets?select=*&condition_id=in." + inList(c))) known[m.condition_id] = m; });
    const want = conds.filter((c) => !known[c] || (!known[c].settle && known[c].game_start_at && R.ms(known[c].game_start_at)! < now));
    const fresh: Record<string, any> = await gammaMarkets(ctx, want, false);
    const newMarkets = Object.values(fresh).filter((m: any) => !known[m.condition_id]);
    if (!ctx.dry && newMarkets.length) await inChunks(newMarkets.map((m: any) => marketRecord(m, true)), 200, (c) => insertOnce("poly_markets", c, "condition_id"));
    for (const m of Object.values(fresh) as any[]) if (known[m.condition_id] && m.settle && !known[m.condition_id].settle && !ctx.dry) {
      await patch("poly_markets?condition_id=eq." + m.condition_id + "&settle=is.null", { settle: m.settle, closed: true, resolved_at: iso(now) });
    }
    const markets: Record<string, any> = {};
    for (const c of conds) markets[c] = fresh[c] || (known[c] ? fromStored(known[c]) : null);
    /* 3. the covered trades, with their transaction hashes (append-only, once) */
    const coveredRows = rows.filter((t: any) => markets[t.condition_id] && R.covered(markets[t.condition_id], rules));
    d.covered = coveredRows.length;
    if (!ctx.dry) await inChunks(coveredRows.map((t: any) => tradeRecord(t, markets[t.condition_id], ctx.run.run_id)), 500,
      (c) => insertOnce("poly_trades", c, "tx_hash,wallet,kind,token_key,side_key,size_key,price_key"));
    if (rows.length) last = Math.max(last || 0, Math.floor(Math.max(...rows.map((t: any) => t.ts)) / 1000));
    /* 4. every newly resolved bet, graded once (the rest next run, if time runs out) */
    const gr = await gradeNewBets(ctx, w.wallet, ctx.dry ? coveredRows : null, markets, late);
    d.graded = gr.n;
    /* 5. done, or kept due with its place: a wallet cut by time is read on, never skipped for 20 hours */
    const partial = actCut || gr.cut, kept: any = { ts_s: last };
    if (first && actCut) kept.first_pages = before + pages;
    d.status = partial ? "partial" : "done";
    if (partial) ctx.run.details.time_up = true;
    if (!ctx.dry) await patch("poly_wallets?wallet=eq." + w.wallet,
      Object.assign({ activity_cursor: kept, history_truncated: truncated, updated_at: iso(now) }, partial ? {} : { activity_synced_at: iso(now) }));
  }
  if (ctx.drift) ctx.alert("DRIFT", "activity_unreadable", ctx.drift + " activity row(s) could not be read (no transaction hash, time, market, or price)");
}

async function gradeNewBets(ctx: any, wallet: string, dryTrades: any[] | null, seenMarkets: Record<string, any>, late?: () => boolean) {
  const rules = ctx.rules;
  const trades = dryTrades || (await dbAll("poly_trades?select=wallet,kind,side,condition_id,token_id,outcome_index,size,price,traded_at,tx_hash&wallet=eq." + wallet + "&order=traded_at")).map(tradeFromStored);
  const conds = Array.from(new Set(trades.map((t: any) => t.condition_id)));
  const markets: Record<string, any> = Object.assign({}, seenMarkets);
  const missing = conds.filter((c) => !markets[c]);
  await inChunks(missing, 100, async (c) => { for (const m of await dbAll("poly_markets?select=*&condition_id=in." + inList(c))) markets[m.condition_id] = fromStored(m); });
  const built = R.buildBets(trades, markets, rules);
  const have = new Set((await dbAll("poly_bets?select=token_id&wallet=eq." + wallet)).map((b: any) => String(b.token_id)));
  /* the newest first, at most a grade's worth a run: the grade reads the most recent max_bets_per_wallet, so a
     wallet's new bets are always graded however many older ones are stored */
  const todo = built.bets.filter((b: any) => b.settle != null && !have.has(b.token_id)).sort((a: any, b: any) => b.entry_at - a.entry_at).slice(0, rules.max_bets_per_wallet);
  let n = 0, cut = false;
  for (const b of todo) {
    if (late && late()) { cut = true; break; }
    /* only the stretches the grade reads (R.gradeWindows): the same grade, without a point a minute for days */
    let hist: any[] = [], failed = false, stop = false;
    for (const w of R.gradeWindows(b, rules)) {
      const r = await ask(ctx, "prices_history", { market: b.token_id, startTs: Math.floor(w.from / 1000), endTs: Math.floor(w.to / 1000), fidelity: 1 });
      if (!r.ok) { failed = true; stop = r.decision === "budget_exhausted" || r.decision === "breaker_open"; break; }
      hist = hist.concat(R.priceHistory(r.data));
    }
    if (stop) break;
    if (failed) continue;
    hist.sort((x: any, y: any) => x.t - y.t);
    const g = R.gradeBet(b, hist, rules);
    if (!ctx.dry) await insertOnce("poly_bets", [betRecord(g, ctx.run.run_id)], "wallet,token_id");
    n++;
  }
  return { n, cut };
}

/* ---------------------------------------------------------------- grade */
async function grade(ctx: any) {
  const rules = ctx.rules, now = ctx.nowMs;
  const pool = await dbAll("poly_wallets?select=wallet,history_truncated&in_pool=is.true&order=wallet");
  const since = iso(now - 365 * DAY)!;
  const grades: any[] = [];
  for (const w of pool) {
    const bets = (await db("poly_bets?select=*&wallet=eq." + w.wallet + "&order=entry_at.desc&limit=" + rules.max_bets_per_wallet) || []).map((b: any) => Object.assign({}, b, {
      entry_at: R.ms(b.entry_at), game_start_at: R.ms(b.game_start_at), settle: Number(b.settle), profit: Number(b.profit), buy_cost: Number(b.buy_cost), stake: Number(b.stake),
      clv_pp: b.clv_pp == null ? null : Number(b.clv_pp), clv_pct: b.clv_pct == null ? null : Number(b.clv_pct),
      follow5_roi: b.follow5_roi == null ? null : Number(b.follow5_roi), follow15_roi: b.follow15_roi == null ? null : Number(b.follow15_roi) }));
    const stats = (await rpc("radar_style_stats", { p_wallet: w.wallet, p_since: since })) || [];
    const g = R.gradeWallet(bets, R.styleFromStats(stats, rules), rules);
    g.wallet = w.wallet;
    g.history_truncated = !!w.history_truncated;
    grades.push(g);
  }
  R.rankWallets(grades, rules);
  const rows = grades.map((g: any) => Object.assign({}, g, { first_bet_at: iso(g.first_bet_at), last_bet_at: iso(g.last_bet_at), rank: g.rank ?? null, top_directional: !!g.top_directional }));
  ctx.run.details.graded_wallets = rows.length;
  ctx.run.details.ranked = rows.filter((g: any) => g.sample === "ranked").length;
  ctx.run.details.top = rows.filter((g: any) => g.top_directional).length;
  if (ctx.dry) { ctx.out.grades = rows.slice(0, 50); return; }
  if (!rows.length) { ctx.alert("WARNING", "nothing_to_grade", "no wallet is in the pool: no grading run written"); return; }
  ctx.out.put = await rpc("radar_put_grades", { p_run: { run_id: ctx.run.run_id, started_at: ctx.run.started_at, grading_version: R.GRADING_VERSION, rules: ctx.rawRules,
    note: "polymarket_sync " + BUILD }, p_grades: rows });
}

/* ---------------------------------------------------------------- one run */
const ON = (v: string) => /^(1|true|yes|on)$/i.test(v || "");
export async function syncOnce(opts: any = {}) {
  const nowMs = opts.now ? Date.parse(opts.now) : Date.now();
  const mode = ["tonight", "pool", "wallets", "grade"].includes(opts.mode) ? opts.mode : "tonight";
  const dry = !!opts.dry;
  const run: any = { run_id: crypto.randomUUID(), mode, trigger: opts.trigger || "manual", status: "ok", started_at: iso(nowMs), requests: 0, details: {} };
  const alerts: any[] = [];
  const ctx: any = { run, dry, nowMs, t0: hooks.now(), out: {}, drift: 0, failedRequests: 0, gw: null, rules: null, rawRules: null,
    alert: (severity: string, code: string, message: string, detail?: any) => alerts.push({ severity, code, message, detail: detail ?? null }) };
  const out: any = { ok: true, build: BUILD, run_id: run.run_id, mode, dry };
  let grant: any = null;
  try {
    if (!env("SUPABASE_URL") || !env("SUPABASE_SERVICE_ROLE_KEY")) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set on this function");
    if (!R || !G) throw new Error("the inlined Radar core or gateway did not load");
    /* the switch: both halves */
    const dbOn = (await rpc("radar_enabled", {})) === true, fnOn = ON(env("POLYMARKET_DATA_ENABLED"));
    if (!dbOn || !fnOn) {
      run.status = "skipped";
      run.message = "POLYMARKET_DATA_ENABLED is off (database: " + (dbOn ? "on" : "off") + ", function: " + (fnOn ? "on" : "off") + "): nothing was asked";
    } else {
      ctx.rawRules = await rpc("radar_rules", {});
      ctx.rules = R.rules(ctx.rawRules);
      let used = 0;
      if (ASK[mode] > 0) {
        grant = await rpc("poly_api_acquire", { p: { run_id: run.run_id, caller: "polymarket_sync:" + mode, requested: ASK[mode] } });
        if (!grant || grant.decision !== "granted") {
          run.status = "skipped";
          run.message = "the gateway refused the run: " + (grant && grant.decision) + (grant && grant.reason ? " (" + grant.reason + ")" : "");
        }
      }
      if (run.status !== "skipped") {
        const limit = grant ? Number(grant.granted) : 0;
        ctx.gw = G.make({ enabled: true, sleep: hooks.sleep, budget: { take: () => { if (used >= limit) return false; used++; return true; } } });
        if (mode === "tonight") await tonight(ctx);
        else if (mode === "pool") await pool(ctx);
        else if (mode === "wallets") await wallets(ctx);
        else await grade(ctx);
      }
    }
    if (alerts.some((a) => a.severity === "FAILURE")) run.status = "error";
    else if (run.status === "ok" && alerts.some((a) => a.severity === "DEGRADED" || a.severity === "DRIFT")) run.status = "warn";
  } catch (e) {
    run.status = "error";
    run.message = mode + " error: " + msg(e);
    ctx.alert("FAILURE", mode + "_error", run.message);
  } finally {
    const st = ctx.gw ? ctx.gw.stats() : null;
    run.requests = st ? st.requests : 0;
    run.finished_at = iso(Math.max(Date.now(), nowMs));
    if (!run.message) run.message = alerts.filter((a) => a.severity !== "WARNING").map((a) => a.message).join("; ").slice(0, 600) || null;
    run.details = Object.assign({}, run.details, { gateway: st, grant: grant ? { grant_id: grant.grant_id, granted: grant.granted, decision: grant.decision } : null, alerts: alerts.map((a) => a.code) });
    Object.assign(out, ctx.out, { status: run.status, message: run.message, details: run.details, alerts, ok: run.status !== "error" });
    try {
      if (grant && grant.grant_id) await rpc("poly_api_settle", { p: { grant_id: grant.grant_id, used: st ? st.requests : 0, rate_limited: st ? st.rate_limited : 0, breaker: !!(st && st.breaker), statuses: st ? st.statuses : {} } });
      if (!dry) {
        await insert("poly_sync_runs", [run]);
        if (alerts.length) await insert("poly_alerts", alerts.map((a) => Object.assign({ run_id: run.run_id }, a)));
      }
    } catch (e) { out.ok = false; out.record_error = msg(e); }
    console.log("POLYMARKET_SYNC", JSON.stringify({ run_id: run.run_id, mode, status: run.status, requests: run.requests, alerts: alerts.map((a) => a.severity + ":" + a.code) }));
  }
  return out;
}

/* ---------------------------------------------------------------- the handler */
/** Constant-time comparison, so the secret cannot be guessed by timing. */
export function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
export async function handle(req: Request): Promise<Response> {
  if (req.method === "GET") return Response.json({ ok: true, build: BUILD, core: R && R.VERSION, gateway: G && G.VERSION });
  if (req.method !== "POST") return Response.json({ ok: false, error: "method" }, { status: 405 });
  const secret = env("POLYMARKET_SYNC_SECRET");
  if (!secret) return Response.json({ ok: false, error: "unauthorized", reason: "POLYMARKET_SYNC_SECRET is not set on this function" }, { status: 401 });
  if (!safeEqual(req.headers.get("x-cron-secret") ?? "", secret)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const body: any = await req.json().catch(() => ({}));
  const mode = String(body.mode || new URL(req.url).searchParams.get("mode") || "tonight");
  if (!["tonight", "pool", "wallets", "grade"].includes(mode)) return Response.json({ ok: false, error: "mode must be tonight, pool, wallets or grade" }, { status: 400 });
  const dry = !!body.dry;
  const out = await syncOnce({ mode, dry, now: dry ? body.now : undefined, trigger: body.source === "supabase_cron" ? "cron" : "manual" });
  return Response.json(out, { status: out.ok ? 200 : 500 });
}
if (typeof (globalThis as any).Deno !== "undefined" && (globalThis as any).Deno.serve && !(globalThis as any).Deno.env.get("POLYMARKET_SYNC_NO_SERVE")) (globalThis as any).Deno.serve(handle);
