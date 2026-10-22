/* ===========================================================================
   EdgeDesk MATCHUP GRAPHIC — the shareable research graphic for one NFL or
   college football game, drawn from one research snapshot.
   Browser: window.EDGameGraphic. Node: require('./edgedesk_game_graphic.js').
   docs/game-research/README.md

   DETERMINISTIC, IN THREE STEPS (only the last touches a canvas)
     content(spec, market)    the words and numbers, from ONE snapshot's
                              graphic spec (EDGameSnapshot.graphicSpec) and,
                              optionally, ONE current market quote
     layout(content, format)  where each piece goes, as plain draw operations
     draw(canvas, layout)     paints them
   No image model, no template per game, nothing typed by hand: the same
   snapshot always gives the same picture, so any historical graphic can be
   drawn again from the history ledger.

   ANOTHER SPORT uses the same template through renderContent(content, key,
   format): its own module builds the content (lib/edgedesk_nhl_graphic.js,
   lib/edgedesk_nba_graphic.js), naming its panels (content.labels), its
   surface ('ice' draws a rink, 'court' a basketball court, not yard lines)
   and a bar colour the dark card shows. Without those fields the picture is
   football's, unchanged.

   THE RULES
     * Every number is the snapshot's own (model) or the quote's own (market),
       already rounded once by lib/edgedesk_calc.js. The graphic computes no
       probability and invents no statistic.
     * The model's spread, total and score print from the spec's display
       block (lib/edgedesk_football_lines.js: half points, PK, whole-number
       scores). A spec recorded before that block existed redraws with the
       numbers it was published with. A sportsbook line prints as received,
       and a model-versus-market gap is the unrounded projection against it.
     * The market panel is the NEAREST market number on file (G.pickMarket):
       a LIVE book quote, else the newer of the page's last captured quote
       (CACHED / STALE) and the snapshot's own market line (spec.consensus),
       titled CURRENT MARKET / LAST KNOWN MARKET / MARKET LINE with its book
       and time. With none, the space carries EdgeDesk's own model detail.
       There is never an empty box and never a made-up price. G.edgeOf names
       the side the unrounded projection leans to ("EDGE: NE +3 · UNDER
       50.5") at SPREAD_EDGE / TOTAL_EDGE points or more.
     * Kalshi (opts.kalshi, EDGameSnapshot.kalshi; docs/KALSHI_NOTES.md) is
       the NEAREST two-sided quote to the model's time: a team's Kalshi mid
       ((yes_bid + yes_ask) / 2, labelled "Kalshi mid") is always compared,
       and G.kalshiCaveat says how far from the model it was quoted (over
       KALSHI_MATCH_MINUTES) and when its YES spread is over
       KALSHI_MAX_SPREAD. The strip is EDGEDESK vs KALSHI (vs MARKET with a
       market): EdgeDesk over the market, the difference as a sentence that
       names the team ("EdgeDesk 9.5 pts higher on NE than Kalshi"), the
       caveat and the large-gap note at LARGE_GAP_PP or more. Only a game
       with no two-sided quote at all says so and compares nothing. Both
       times are always printed ("Model 2:04 PM ET · Kalshi 2:05 PM ET").
       EdgeDesk's row is unrounded and the market's as received, so each
       difference is the two numbers above it. A side without a mid has no
       column; nothing is derived from the other. G.kalshiAtModel picks, from
       kalshi_price_snapshots, the two-sided quote nearest the model snapshot
       for each linked market.
     * What to watch for prints the snapshot's insights as published (up to
       six: a grid of three across square, two across portrait), except
       home field, which is restated from the numbers (G.homeFieldText): the
       neutral-site margin is the projected margin minus home field.
     * Labels say what a number is: a spread is a line, not a win chance; a
       market probability is "no-vig", never "model"; reliability is out of
       100, never a percent; the model moneyline is "a model estimate, not a
       price".
     * Research, not picks: no "bet", "lock" or "play" anywhere; the copy rule
       (EDPersonal.BANNED) is applied to every string.
     * Team identity is presentation: a monogram badge in the team's colours.
       No team logo or helmet is drawn: EdgeDesk holds no licence for them
       (opts.logos is reserved for licensed assets and is off).
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EDGameGraphic = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var G = { VERSION: 'edgedesk_game_graphic/3', TEMPLATE: 'matchup_v1' };
  G.FORMATS = {
    square: { w: 1080, h: 1080, label: 'Square · 1080×1080' },
    portrait: { w: 1080, h: 1350, label: 'Portrait · 1080×1350' }
  };
  G.SITE = 'edgedesksports.com';
  G.TAGLINE = 'RESEARCH NOT PICKS.';
  G.K = {
    bg0: '#040814', bg1: '#0a1636', bg2: '#070d22', panel: 'rgba(8,16,40,0.86)', panel2: 'rgba(14,28,66,0.92)', strip: 'rgba(18,40,92,0.95)',
    cyan: '#2ad4ff', blue: '#3b82f6', magenta: '#e040fb', violet: '#8b5cf6',
    text: '#ffffff', dim: '#c3cfea', faint: '#8693b8', line: 'rgba(130,160,230,0.28)',
    green: '#4ade80', warn: '#fbbf24', fault: '#f87171', gold: '#facc15', ink: '#0b1020'
  };
  G.DISPLAY = '"Barlow Condensed", "Roboto Condensed", "Arial Narrow", Arial, sans-serif';
  G.BODY = 'Inter, "Helvetica Neue", Arial, sans-serif';
  G.BANNED = /(bet this|\blocks?\b|guarantee|\bsmash|must[- ]bet|can'?t lose|best bets?|winning plays?|free money|sure thing)/i;
  G.REASON_TEXT = {
    no_spec: 'EdgeDesk holds no research snapshot for this game.',
    copy_rule: 'This graphic would break EdgeDesk’s research-only wording rules, so it is not made.'
  };
  G.FAULT_TEXT = {
    scores_reconcile: 'PROJECTED SCORES DO NOT MATCH THE SPREAD AND TOTAL',
    headline_scores_within_tolerance: 'ROUNDED SCORES DRIFT FROM THE SPREAD AND TOTAL',
    win_probabilities_sum: 'WIN PROBABILITIES DO NOT ADD TO 100%',
    win_display_sums_100: 'WIN PROBABILITIES DO NOT ADD TO 100%',
    winner_agrees: 'WIN PROBABILITY AND SPREAD NAME DIFFERENT FAVOURITES',
    model_moneyline_restates_probability: 'MODEL MONEYLINE DOES NOT MATCH THE WIN PROBABILITY',
    total_plausible: 'FAIR TOTAL OUTSIDE THE PLAUSIBLE RANGE',
    range_contains_projection: 'OUTCOME RANGE DOES NOT CONTAIN THE PROJECTION',
    ranks_in_range: 'A UNIT RANK FALLS OUTSIDE ITS LEAGUE'
  };
  G.BOOKS = { draftkings: 'DraftKings', fanduel: 'FanDuel', betmgm: 'BetMGM', williamhill_us: 'Caesars', caesars: 'Caesars', espnbet: 'ESPN BET', fanatics: 'Fanatics',
    betrivers: 'BetRivers', hardrockbet: 'Hard Rock Bet', pinnacle: 'Pinnacle', circasports: 'Circa Sports', bovada: 'Bovada', betonlineag: 'BetOnline', lowvig: 'LowVig' };
  /* the Kalshi comparison's display rules (docs/KALSHI_NOTES.md). A Kalshi
     price is set beside the model only when it was quoted within
     KALSHI_MATCH_MINUTES of the model snapshot and its YES spread is at most
     KALSHI_MAX_SPREAD; otherwise the card says it is unavailable rather than
     show a conclusion EdgeDesk does not own. A win-probability gap of
     LARGE_GAP_PP percentage points or more adds the large-gap note. */
  G.KALSHI_MATCH_MINUTES = 15;
  G.KALSHI_MAX_SPREAD = 0.06;
  G.LARGE_GAP_PP = 7;
  /* the edge strip names a side only from this far: points on the spread and
     the total, percentage points of win probability against Kalshi */
  G.SPREAD_EDGE = 1.5;
  G.TOTAL_EDGE = 2;
  G.KALSHI_EDGE_PP = 4;
  G.KALSHI_TEXT = {
    unavailable: 'No two-sided Kalshi quote on record',
    large_gap: 'Large gap vs market. Checking injuries, QB status, and weather before trusting it.'
  };

  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function str(x) { return x == null ? '' : String(x); }
  function up(x) { return str(x).toUpperCase(); }
  function signed(v, dp) { v = num(v); if (v == null) return '—'; if (v === 0) return 'PK'; return (v > 0 ? '+' : '−') + Math.abs(v).toFixed(dp == null ? 1 : dp); }
  /* a sportsbook number as received: at least one decimal, never rounded */
  function exact(v) { var t = String(Math.round(Math.abs(v) * 1000) / 1000); return t.indexOf('.') < 0 ? t + '.0' : t; }
  function signedExact(v) { v = num(v); if (v == null) return '—'; if (v === 0) return 'PK'; return (v > 0 ? '+' : '−') + exact(v); }
  /* a gap in integer tenths, each side rounded half away from zero first,
     exactly as lib/edgedesk_calc.js computes it */
  function t10(x) { return Math.round(Math.floor(Math.abs(x) * 10 + 0.5 + 1e-9) * (x < 0 ? -1 : 1)); }
  function gapOf(a, b) { var v = (t10(a) - t10(b)) / 10; return v === 0 ? 0 : v; }
  G.ROUNDING_NOTE = '½-POINT FAIR LINES · GAPS UNROUNDED';
  function am(v) { v = num(v); return v == null ? '—' : (v > 0 ? '+' : '−') + Math.abs(Math.round(v)); }
  function pct(p) { p = num(p); return p == null ? '—' : Math.round(p * 100) + '%'; }

  var ET = null;
  try { ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' }); } catch (_) { ET = null; }
  G.stamp = function (iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return null;
    if (!ET || typeof ET.formatToParts !== 'function') return new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    var p = {}; ET.formatToParts(new Date(t)).forEach(function (x) { p[x.type] = x.value; });
    return p.month + ' ' + p.day + ', ' + p.hour + ':' + p.minute + ' ' + str(p.dayPeriod).toUpperCase() + ' ' + (/^E[DS]T$/.test(p.timeZoneName) ? 'ET' : p.timeZoneName);
  };
  /* the time alone ("6:40 PM ET"), for a price taken on the graphic's own day */
  G.clock = function (iso) { var s = G.stamp(iso); return s ? s.replace(/^[A-Z][a-z]{2} \d{1,2}, /, '') : null; };
  /* the model's and Kalshi's times for the card: "Model 2:04 PM ET · Kalshi 2:05 PM ET",
     with the date on both when they fall on different days (ET) */
  G.timesLine = function (modelAt, kalshiAt) {
    var ms = G.stamp(modelAt), ks = kalshiAt ? G.stamp(kalshiAt) : null;
    var day = function (s) { return s ? s.split(', ')[0] : null; }, same = !ks || !ms || day(ms) === day(ks);
    return 'Model ' + (ms ? (same ? G.clock(modelAt) : ms) : 'time unknown') + ' · Kalshi ' + (ks ? (same ? G.clock(kalshiAt) : ks) : 'no quote');
  };
  function bookName(b) { b = str(b); var k = b.toLowerCase().replace(/[^a-z_]/g, ''); return G.BOOKS[k] || b; }
  /* a duration in words: "12 min", "2 h 6 min", "3 days" */
  function dur(min) { min = Math.round(Math.abs(min)); if (min < 60) return min + ' min'; if (min < 2880) return Math.floor(min / 60) + ' h' + (min % 60 ? ' ' + (min % 60) + ' min' : ''); return Math.round(min / 1440) + ' days'; }

  /* ================================================================ KALSHI AT THE MODEL'S TIME
     The YES mid of one Kalshi quote: (yes_bid + yes_ask) / 2, only for a
     two-sided quote (a bid above 0, an ask below 1, not crossed), exactly as
     public.kalshi_snapshot_mid computes it; spread = ask − bid. */
  G.kalshiMid = function (bid, ask) {
    bid = num(bid); ask = num(ask);
    var spread = bid != null && ask != null ? Math.round((ask - bid) * 1e4) / 1e4 : null;
    var two = bid != null && ask != null && bid > 0 && ask < 1 && ask >= bid;
    return { mid: two ? Math.round((bid + ask) / 2 * 1e4) / 1e4 : null, spread: spread, two_sided: two };
  };
  /* One game's linked Kalshi markets, re-stated at the model snapshot's time.
       rows     the game's links as public.kalshi_card_current (or
                kalshi_game_links) holds them: market_ticker, the team names
                EDGameSnapshot.kalshi places by, kickoff_at
       snaps    public.kalshi_price_snapshots rows for those tickers (ticker,
                captured_at, yes_bid, yes_ask[, volume]); at least the nearest
                before and the nearest after the model time
       modelAt  the model snapshot's time (spec.model.built_at)
     Each row takes the snapshot NEAREST modelAt (a tie goes to the earlier
     one: nothing quoted after the model is preferred over what was known at
     it) and a state, so EDGameSnapshot.kalshi places only what may be drawn:
       OK                  within KALSHI_MATCH_MINUTES, two-sided, spread at
                           most KALSHI_MAX_SPREAD; yes_mid is set
       TIME_GAP            the nearest quote is further than that from the model
       NO_TWO_SIDED_QUOTE  no bid or no ask (or crossed): no mid
       WIDE_SPREAD         spread over KALSHI_MAX_SPREAD: no mid
       NO_SNAPSHOT         no quote for the market at all
     The rows are copies (the caller's are not touched), and the book-gap
     columns of the latest snapshot are cleared: they belong to another time.
     → { state: 'ok', rows, model_at, quote_at } quote_at: the nearest quote's
       time across the game's markets, for the card's "Kalshi …" time */
  G.kalshiAtModel = function (rows, snaps, modelAt) {
    var t = Date.parse(modelAt), iso = isFinite(t) ? new Date(t).toISOString() : null;
    var by = {}, quoteAt = null, best = Infinity;
    (snaps || []).forEach(function (s) { if (s && s.ticker && isFinite(Date.parse(s.captured_at))) (by[s.ticker] = by[s.ticker] || []).push(s); });
    function nearest(list) {
      var b = null, bd = Infinity;
      /* the nearest TWO-SIDED quote when the market has one: a one-sided book has no price to show */
      var two = (list || []).filter(function (s) { return G.kalshiMid(s.yes_bid, s.yes_ask).mid != null; });
      (two.length ? two : list || []).forEach(function (s) {
        var at = Date.parse(s.captured_at), d = Math.abs(at - t);
        if (d < bd || (d === bd && b && at < Date.parse(b.captured_at))) { b = s; bd = d; }
      });
      return b;
    }
    var out = (rows || []).map(function (r) {
      var o = {};
      Object.keys(r || {}).forEach(function (k) { o[k] = r[k]; });
      ['yes_mid', 'yes_bid', 'yes_ask', 'spread', 'snapshot_at', 'snapshot_age_minutes', 'volume', 'gap_basis', 'gap_snapshot_at', 'gap_kalshi_mid', 'book_fair_prob', 'book_at', 'time_diff_minutes', 'gap_pp']
        .forEach(function (k) { o[k] = null; });
      var ko = Date.parse(r && r.kickoff_at);
      o.pregame = isFinite(t) && isFinite(ko) ? t < ko : (r ? r.pregame : null);
      o.model_at = iso; o.minutes_from_model = null;
      if (!isFinite(t)) { o.state = 'NO_MODEL_TIME'; return o; }
      var near = nearest(by[r && r.market_ticker]);
      if (!near) { o.state = 'NO_SNAPSHOT'; return o; }
      var at = Date.parse(near.captured_at), mins = Math.abs(at - t) / 60000, q = G.kalshiMid(near.yes_bid, near.yes_ask);
      if (Math.abs(at - t) < best) { best = Math.abs(at - t); quoteAt = near.captured_at; }
      o.snapshot_at = near.captured_at; o.minutes_from_model = Math.round(mins * 10) / 10;
      o.yes_bid = num(near.yes_bid); o.yes_ask = num(near.yes_ask); o.spread = q.spread; o.volume = num(near.volume);
      /* the mid travels with every two-sided quote; the state says what to tell the reader about it */
      if (q.mid == null) o.state = 'NO_TWO_SIDED_QUOTE';
      else {
        o.yes_mid = q.mid;
        o.state = mins > G.KALSHI_MATCH_MINUTES ? 'TIME_GAP' : (q.spread > G.KALSHI_MAX_SPREAD + 1e-9 ? 'WIDE_SPREAD' : 'OK');
      }
      return o;
    });
    return { state: 'ok', rows: out, model_at: iso, quote_at: quoteAt };
  };
  /* may this placed side (EDGameSnapshot.kalshi's away / home) be set beside a
     model built at modelAt? null when it may; else why not. Any two-sided mid
     with a capture time is shown: the NEAREST quote, never withheld for its
     age or its spread. Those are said beside it (G.kalshiCaveat). */
  G.kalshiRefusal = function (side, modelAt) {
    if (!side) return 'no_price';
    var at = Date.parse(side.snapshot_at), mid = num(side.mid);
    if (mid == null || mid <= 0 || mid >= 1) return 'no_price';
    if (!isFinite(at)) return 'no_quote_time';
    void modelAt;
    return null;
  };
  /* what a reader should know about a shown quote: how far it sits from the
     model's time (over KALSHI_MATCH_MINUTES) and a YES spread over
     KALSHI_MAX_SPREAD. null when it is a quote at the model's time. */
  G.kalshiCaveat = function (side, modelAt) {
    if (!side) return null;
    var t = Date.parse(modelAt), at = Date.parse(side.snapshot_at), sp = num(side.spread), out = [];
    if (isFinite(t) && isFinite(at) && Math.abs(at - t) > G.KALSHI_MATCH_MINUTES * 60000) out.push('Nearest Kalshi quote: ' + dur((at - t) / 60000) + (at > t ? ' after' : ' before') + ' the model');
    else if (!isFinite(t)) out.push('Model time not on record');
    if (sp != null && sp > G.KALSHI_MAX_SPREAD + 1e-9) out.push('wide ' + Math.round(sp * 100) + '¢ Kalshi spread');
    return out.length ? out.join(' · ') : null;
  };

  /* ================================================================ THE MARKET SHOWN
     The nearest market number EdgeDesk holds for a game, newest first:
       a LIVE book quote (the reader's page, lib/edgedesk_market_state.js);
       else the most recent of the page's last captured quote (CACHED /
       STALE) and the snapshot's own market line (spec.consensus: the CFB
       research terminal's latest book quote, or nflverse's consensus line).
     A manual, reference-only or faulted quote is never shown. */
  var MK_OK = { LIVE: 1, CACHED: 1, STALE: 1 };
  function hasNumbers(m) { return m && (num(m.home_line) != null || num(m.total) != null || (num(m.ml_home) != null && num(m.ml_away) != null)); }
  G.pickMarket = function (spec, market) {
    var page = market && MK_OK[market.state] && hasNumbers(market) ? market : null;
    if (page && page.state === 'LIVE') return page;
    var cs = spec && spec.consensus && hasNumbers(spec.consensus) ? spec.consensus : null;
    var cons = cs ? { state: 'CONSENSUS', current: false, home_line: num(cs.home_line), total: num(cs.total), ml_home: num(cs.ml_home), ml_away: num(cs.ml_away),
      book: cs.book || null, books: null, label: cs.label || null, captured_at: cs.as_of || null, source: cs.source || null } : null;
    if (page && cons) return (Date.parse(cons.captured_at) || 0) > (Date.parse(page.captured_at) || 0) ? cons : page;
    return page || cons;
  };
  function marketSource(mk) {
    if (mk.book) return bookName(mk.book);
    if (mk.books) return mk.books + ' books';
    if (mk.state === 'CONSENSUS') return mk.label ? (/nflverse/i.test(mk.label) ? 'Consensus line' : bookName(mk.label)) : 'Consensus line';
    return 'captured quote';
  }
  /* THE EDGE, from the unrounded projection against the market shown:
     spread  the side the projection leans to, at the market's line, when
             the gap is SPREAD_EDGE points or more ("NE +3")
     total   OVER or UNDER the market's total at TOTAL_EDGE points or more
     → { spread, total, headline } (headline null when neither clears) */
  G.edgeOf = function (M, mk, awayAb, homeAb) {
    var out = { spread: null, total: null, kalshi: null, headline: null, source: marketSource(mk), state: mk.state, at: mk.captured_at || null };
    var hl = num(mk.home_line), tot = num(mk.total);
    if (hl != null && num(M.home_margin) != null) {
      var g = gapOf(-M.home_margin, hl);
      if (Math.abs(g) >= G.SPREAD_EDGE) {
        var side = g > 0 ? 'away' : 'home', line = side === 'home' ? hl : -hl;
        out.spread = { side: side, team: side === 'home' ? homeAb : awayAb, line: line, line_text: (line === 0 ? 'PK' : (line > 0 ? '+' : '−') + exact(line).replace(/\.0$/, '')), pts: Math.abs(g) };
      }
    }
    var te = num(M.total_exact) != null ? num(M.total_exact) : num(M.total);
    if (tot != null && te != null) {
      var tg = gapOf(te, tot);
      if (Math.abs(tg) >= G.TOTAL_EDGE) out.total = { dir: tg > 0 ? 'OVER' : 'UNDER', line: tot, line_text: exact(tot).replace(/\.0$/, ''), pts: Math.abs(tg) };
    }
    var parts = [];
    if (out.spread) parts.push(out.spread.team + ' ' + out.spread.line_text);
    if (out.total) parts.push(out.total.dir + ' ' + out.total.line_text);
    out.headline = parts.length ? parts.join(' · ') : null;
    out.detail = [out.spread ? out.spread.pts.toFixed(1) + ' pts on the spread' : null, out.total ? out.total.pts.toFixed(1) + ' pts on the total' : null].filter(Boolean).join(', ') || null;
    return out;
  };

  /* ================================================================ HOME FIELD
     The home-field watch item, restated from the numbers. hm is the
     projected home margin (home minus away, unrounded: spec.model.home_margin),
     hfa the home-field points the item prints ("+3.1 pts for playing at
     home"); the neutral-site margin is hm − hfa, each rounded to one decimal.
       away still favoured at home      "Home field takes 3.1 pts off NE’s edge."
       home favoured on a neutral field "Home field adds 3.1 pts to CHI’s edge."
       otherwise (it flips or erases)   "Home field is the whole game. Neutral
                                         site, NE is about a 3-pt favorite."
     null when a number is missing. */
  G.HOME_FIELD_RE = /\+(\d+(?:\.\d+)?) pts? for playing at home/;
  function tenth(v) { return t10(v) / 10 || 0; }
  function pts1(v) { return Math.abs(tenth(v)).toFixed(1).replace(/\.0$/, ''); }
  G.homeFieldText = function (hm, hfa, homeAbbr, awayAbbr) {
    hm = num(hm); hfa = num(hfa);
    if (hm == null || hfa == null || tenth(hfa) <= 0) return null;
    var p = tenth(hm), n = tenth(hm - hfa), h = pts1(hfa), u = h === '1' ? ' pt' : ' pts';
    if (p < 0) return { kind: 'trims', title: 'HOME FIELD', neutral: n, text: 'Home field takes ' + h + u + ' off ' + awayAbbr + '’s edge.' };
    if (n > 0) return { kind: 'adds', title: 'HOME FIELD', neutral: n, text: 'Home field adds ' + h + u + ' to ' + homeAbbr + '’s edge.' };
    return { kind: 'decides', title: 'HOME FIELD DECIDES IT', neutral: n,
      text: 'Home field is the whole game. Neutral site, ' + (n === 0 ? 'it’s a pick’em.' : awayAbbr + ' is about a ' + pts1(n) + '-pt favorite.') };
  };

  /* ================================================================ CONTENT */
  G.content = function (spec, market, opts) {
    opts = opts || {};
    if (!spec || !spec.home || !spec.away) return { ok: false, reason: 'no_spec', message: G.REASON_TEXT.no_spec };
    var M = spec.model || {}, H = spec.home, A = spec.away;
    var leagueLabel = spec.league === 'nfl' ? 'NFL' : 'COLLEGE FOOTBALL';
    var now = num(opts.now) || Date.now(), ko = Date.parse(spec.kickoff);
    var c = {
      template: G.TEMPLATE, league: spec.league, league_label: leagueLabel, week_label: up(spec.week_label || ''),
      snapshot_id: spec.snapshot_id || null,
      away: team(A), home: team(H),
      date: spec.kickoff_text ? up(spec.kickoff_text.date) + (spec.kickoff_text.time ? ' • ' + up(spec.kickoff_text.time) : '') : 'DATE TBA',
      venue: up(spec.venue || ''), context: up(spec.neutral_site ? (spec.context ? spec.context + ' · neutral site' : 'Neutral site') : (spec.context || '')),
      started: isFinite(ko) && now >= ko,
      model_available: !!M.available,
      reason: M.available ? null : (M.reason || 'the model has no projection for this game')
    };
    function team(t) {
      return { name: up(t.name), short: up(t.short || t.name), abbr: up(t.abbr || ''), color: t.color || '#3b4a6b', alt: t.alt_color || '#8aa0c8', on: t.on_color || '#ffffff',
        record: t.record ? '(' + t.record + ')' : '', rank: num(t.poll_rank) != null ? '#' + t.poll_rank : '' };
    }
    if (M.available) {
      var D = M.display || null;
      var fav = D ? D.spread.favorite : M.fair.favorite, favT = fav ? (fav === 'home' ? H : A) : null;
      var hs = D ? { home: String(D.score.home), away: String(D.score.away), whole: true } : (M.headline_scores || { home: String(M.scores.home), away: String(M.scores.away) });
      c.spread_team = favT ? up(favT.short || favT.name) : 'PICK’EM';
      c.spread_value = D ? D.spread.line_text : (fav ? '−' + Math.abs(M.fair.display).toFixed(1) : 'PK');
      c.spread_text = D ? D.spread.text : M.fair.text;
      c.win = { away: M.win_display.away, home: M.win_display.home, away_pct: M.win_display.away_pct, home_pct: M.win_display.home_pct };
      c.fav_side = fav;
      c.scores = { away: hs.away, home: hs.home, whole: hs.whole !== false };
      c.total = D ? D.total.text : M.total.toFixed(1);
      c.points = { away: num(M.scores.away).toFixed(M.scores.decimals === 2 ? 2 : 1), home: num(M.scores.home).toFixed(M.scores.decimals === 2 ? 2 : 1) };
      /* under the fair total: the unrounded total beside a half-point display;
         the reconciled points on a spec published before it */
      c.total_sub = D ? { label: 'UNROUNDED PROJECTION', text: D.total.raw_text + ' PTS' } : { label: 'PROJECTED POINTS', text: null };
      c.fair_ml = { away: am(M.fair_ml.away), home: am(M.fair_ml.home) };
      c.range = M.range80 ? rangeAbbr(M.range80.lo, M.range80.hi, c.away.abbr, c.home.abbr) : null;
      c.range_text = c.range ? c.range.join(' ') : null;
    }
    /* the market strip: the nearest market number on file (G.pickMarket), labelled with its age */
    var mk = M.available ? G.pickMarket(spec, market) : null;
    if (mk && M.available) {
      var hl = num(mk.home_line), tot = num(mk.total);
      c.market = {
        title: mk.state === 'LIVE' ? 'CURRENT MARKET' : (mk.state === 'CONSENSUS' ? 'MARKET LINE' : 'LAST KNOWN MARKET'), state: mk.state,
        meta: [marketSource(mk), mk.captured_at ? (mk.state === 'LIVE' ? 'captured ' : 'as of ') + G.stamp(mk.captured_at) : null].filter(Boolean).join(' · '),
        away_spread: hl != null ? (D ? signedExact(hl === 0 ? 0 : -hl) : signed(hl === 0 ? 0 : -hl)) : null, home_spread: hl != null ? (D ? signedExact(hl) : signed(hl)) : null,
        total: tot != null ? (D ? exact(tot) : tot.toFixed(1)) : null,
        away_ml: num(mk.ml_away) != null ? am(mk.ml_away) : null, home_ml: num(mk.ml_home) != null ? am(mk.ml_home) : null,
        no_vig: null, vs: []
      };
      if (num(mk.ml_home) != null && num(mk.ml_away) != null) {
        var ih = impl(mk.ml_home), ia = impl(mk.ml_away);
        if (ih && ia) c.market.no_vig = { away: pct(ia / (ia + ih)), home: pct(ih / (ia + ih)) };
      }
      if (hl != null && D) {
        /* the unrounded projection against the line as received */
        var sg = gapOf(-M.home_margin, hl), shown = Math.abs(Math.round((num(D.spread.home_line) - hl) * 100) / 100);
        c.market.vs.push(sg === 0 ? 'Spread: EdgeDesk and the market agree' : 'Spread: EdgeDesk ' + Math.abs(sg).toFixed(1) + ' pts toward ' + (sg < 0 ? c.home.abbr : c.away.abbr));
        if (Math.abs(shown - Math.abs(sg)) > 1e-9) c.market.note = G.ROUNDING_NOTE;
      } else if (hl != null) {
        var fair = Math.round(-M.home_margin * 10) / 10, mkt = Math.round(hl * 10) / 10;
        var gap = Math.abs(Math.round(fair * 10) - Math.round(mkt * 10)) / 10;
        c.market.vs.push(gap < 0.05 ? 'Spread: EdgeDesk and the market agree' : 'Spread: EdgeDesk ' + gap.toFixed(1) + ' pts toward ' + (fair < mkt ? c.home.abbr : c.away.abbr));
      }
      if (tot != null && D) {
        var te = num(M.total_exact) != null ? num(M.total_exact) : M.total, tg2 = gapOf(te, tot), tshown = Math.abs(Math.round((num(D.total.value) - tot) * 100) / 100);
        c.market.vs.push(tg2 === 0 ? 'Total: EdgeDesk and the market agree' : 'Total: EdgeDesk ' + Math.abs(tg2).toFixed(1) + ' pts ' + (tg2 > 0 ? 'higher' : 'lower'));
        if (Math.abs(tshown - Math.abs(tg2)) > 1e-9) c.market.note = G.ROUNDING_NOTE;
      } else if (tot != null) {
        var tg = (Math.round(M.total * 10) - Math.round(tot * 10)) / 10;
        c.market.vs.push(tg === 0 ? 'Total: EdgeDesk and the market agree' : 'Total: EdgeDesk ' + Math.abs(tg).toFixed(1) + ' pts ' + (tg > 0 ? 'higher' : 'lower'));
      }
    }
    /* THE EDGE: where EdgeDesk's unrounded projection sits far enough from
       the market shown to name a side (SPREAD_EDGE / TOTAL_EDGE points) */
    if (mk && M.available) c.edge = G.edgeOf(M, mk, c.away.abbr || c.away.short, c.home.abbr || c.home.short);
    /* Kalshi beside EdgeDesk, at the quote NEAREST the model's time (docs/KALSHI_NOTES.md).
       opts.kalshi is EDGameSnapshot.kalshi's placement of each team's quote
       (OK), or of a listed game with no usable quote (NO_PRICE); a caller
       that read kalshi_price_snapshots placed the quote nearest the model
       (G.kalshiAtModel). The rules hold here, whoever drew the graphic:
         * a side is compared only when its quote was taken within
           KALSHI_MATCH_MINUTES of spec.model.built_at and its YES spread is
           at most KALSHI_MAX_SPREAD; its price is the YES mid, "Kalshi mid";
         * no side passes: "Kalshi price unavailable at model time" in
           Kalshi's place, and nothing of Kalshi's is compared;
         * both times, always: "Model 2:04 PM ET · Kalshi 2:05 PM ET";
         * the difference is one sentence naming the team ("EdgeDesk 9.5
           pts higher on NE than Kalshi": percentage points, before fees),
           and a gap of LARGE_GAP_PP or more adds the large-gap note.
       The table: one column per market (the live book's spread and total,
       then each usable Kalshi team), rows EdgeDesk / the market / the
       difference. EdgeDesk's numbers are its unrounded projection at one
       decimal and the market's are as received, so every difference is the
       subtraction of two numbers printed above it. */
    var kin = opts.kalshi && (opts.kalshi.state === 'OK' || opts.kalshi.state === 'NO_PRICE') ? opts.kalshi : null;
    if (kin && M.available) {
      var mAt = M.built_at || spec.generated_at || null, usable = {}, refused = null, nearAt = null, nearD = Infinity, caveat = null;
      ['away', 'home'].forEach(function (k) {
        var s = kin[k];
        if (!s) return;
        var why = G.kalshiRefusal(s, mAt), at = Date.parse(s.snapshot_at), d = Math.abs(at - Date.parse(mAt));
        if (isFinite(d) && d < nearD) { nearD = d; nearAt = s.snapshot_at; }
        if (why) { refused = refused || { why: why, side: s }; return; }
        usable[k] = s;
        var cv = G.kalshiCaveat(s, mAt);
        if (cv && (!caveat || cv.length > caveat.length)) caveat = cv;
      });
      var cmp = [], one = function (x) { return (t10(x) / 10).toFixed(1); };
      var fav = function (homeLine, txt) { return homeLine === 0 ? 'PK' : (homeLine > 0 ? c.away.abbr : c.home.abbr) + ' −' + txt(Math.abs(homeLine)); };
      if (mk && num(mk.home_line) != null) {
        var mh = num(mk.home_line), eh = -M.home_margin, sgap = gapOf(eh, mh);
        cmp.push({ head: 'SPREAD', ed: fav(t10(eh) === 0 ? 0 : eh, one), mk: fav(mh, exact),
          diff: sgap === 0 ? 'EVEN' : Math.abs(sgap).toFixed(1) + ' TOWARD ' + (sgap < 0 ? c.home.abbr : c.away.abbr) });
      }
      if (mk && num(mk.total) != null) {
        var mt = num(mk.total), et = num(M.total_exact) != null ? num(M.total_exact) : M.total, tgap = gapOf(et, mt);
        cmp.push({ head: 'TOTAL', ed: one(et), mk: exact(mt), diff: tgap === 0 ? 'EVEN' : Math.abs(tgap).toFixed(1) + (tgap > 0 ? ' HIGHER' : ' LOWER') });
      }
      /* each usable team: EdgeDesk's win % minus Kalshi's mid, in tenths of a percentage point */
      var gaps = [];
      ['away', 'home'].forEach(function (k) {
        var s = usable[k], pm = M.win_prob ? num(M.win_prob[k]) : null;
        if (!s || pm == null) return;
        var d = (t10(pm * 100) - t10(s.mid * 100)) / 10 || 0;
        cmp.push({ head: c[k].abbr + ' WIN % · ML', win: true, side: k, ed: one(pm * 100) + '%  ' + c.fair_ml[k], mk: one(s.mid * 100) + '%  ' + am(s.ml), gap_pp: d });
        gaps.push({ k: k, d: d });
      });
      /* the sentence names the team with the larger gap; on a tie, the team EdgeDesk is higher on, then the away team */
      gaps.sort(function (a, b) { return Math.abs(b.d) - Math.abs(a.d) || (b.d > 0) - (a.d > 0); });
      var named = gaps[0] || null, ok = !!named;
      var kAt = ok ? Object.keys(usable).map(function (k) { return usable[k].snapshot_at; }).sort().pop() : (nearAt || kin.snapshot_at || kin.quote_at || null);
      var KC = { available: ok, close: !!kin.close, model_at: mAt, kalshi_at: kAt, diff: null, gap_pp: null, team: null, large_gap: false, note: null, caveat: null, unavailable: null, reason: null };
      if (ok) {
        var ab = c[named.k].abbr, g1 = Math.abs(named.d).toFixed(1);
        KC.team = ab; KC.gap_pp = named.d;
        KC.diff = named.d === 0 ? 'EdgeDesk matches Kalshi on ' + ab : 'EdgeDesk ' + g1 + ' pts ' + (named.d > 0 ? 'higher' : 'lower') + ' on ' + ab + ' than Kalshi';
        KC.large_gap = Math.round(Math.abs(named.d) * 10) >= Math.round(G.LARGE_GAP_PP * 10);
        KC.caveat = caveat;
        KC.note = [caveat, KC.large_gap ? G.KALSHI_TEXT.large_gap : null].filter(Boolean).join(' · ') || null;
        if (c.edge && Math.abs(named.d) >= G.KALSHI_EDGE_PP) c.edge.kalshi = { team: ab, pp: named.d, text: ab + ' ' + (named.d > 0 ? '+' : '−') + g1 + ' pts vs Kalshi' };
      } else {
        KC.unavailable = G.KALSHI_TEXT.unavailable;
        var gapMin = kAt && isFinite(Date.parse(mAt)) ? Math.abs(Date.parse(kAt) - Date.parse(mAt)) / 60000 : null;
        var lab = str(kin.label);
        KC.reason = refused && refused.why === 'wide_spread' ? 'Kalshi spread ' + Math.round(num(refused.side.spread) * 100) + '¢ is over the ' + Math.round(G.KALSHI_MAX_SPREAD * 100) + '¢ limit'
          : !isFinite(Date.parse(mAt)) ? 'The model snapshot has no time on record'
          : gapMin != null && gapMin > G.KALSHI_MATCH_MINUTES ? 'Closest Kalshi quote is ' + dur(gapMin) + ' from the model snapshot'
          : lab === 'wide spread' ? 'Kalshi spread is over the ' + Math.round(G.KALSHI_MAX_SPREAD * 100) + '¢ limit'
          : lab === 'one-sided book' ? 'No two-sided Kalshi quote at model time'
          : lab === 'no snapshot' || !kAt ? 'No Kalshi quote on record near the model time'
          : 'No usable Kalshi quote at model time';
      }
      var src = mk ? marketSource(mk) : null;
      var bookAt = mk && mk.captured_at ? (Math.abs(Date.parse(mk.captured_at) - Date.parse(mAt)) > 12 * 36e5 || mk.state !== 'LIVE' ? G.stamp(mk.captured_at) : G.clock(mk.captured_at)) : null;
      var bookRow = src ? up(src) + (bookAt ? ' ' + bookAt : '') : null;
      var kRow = kin.close ? 'KALSHI CLOSE MID' : 'KALSHI MID';
      c.kalshi = { available: ok, close: !!kin.close, time: kAt ? G.clock(kAt) : null, model_time: G.clock(mAt),
        away: usable.away ? one(usable.away.mid * 100) + '%' : null, home: usable.home ? one(usable.home.mid * 100) + '%' : null };
      c.compare = {
        title: c.edge && c.edge.headline ? 'EDGE: ' + c.edge.headline : (mk ? 'EDGEDESK vs MARKET' : 'EDGEDESK vs KALSHI'),
        edge: !!(c.edge && c.edge.headline),
        /* the market row says which market: "DRAFTKINGS 7:32 PM ET · KALSHI MID"; the times line says when */
        rows: ['EDGEDESK · UNROUNDED', [bookRow, ok ? kRow : null].filter(Boolean).join(' · '), 'DIFFERENCE · BEFORE FEES'],
        book_row: bookRow,
        cols: cmp,
        kalshi: KC,
        times: G.timesLine(mAt, kAt),
        note: [src ? src + (bookAt ? ' ' + bookAt : '') : null,
          ok ? (kin.close ? 'Kalshi close mid (its last price before kickoff)' : 'Kalshi mid = (YES bid + YES ask) / 2') : null,
          ok ? 'EdgeDesk unrounded, win % with its fair moneyline · differences in percentage points, before Kalshi’s fees' : null].filter(Boolean).join(' · ')
      };
    }
    function rangeAbbr(lo, hi, aw, hm) {
      function one(v) { var r = Math.round(v); return r === 0 ? 'A TIE' : (r > 0 ? hm : aw) + ' BY ' + Math.abs(r); }
      return [one(lo), 'TO ' + one(hi)];
    }
    function impl(a) { a = num(a); if (a == null || (a > -100 && a < 100)) return null; return a > 0 ? 100 / (a + 100) : -a / (-a + 100); }
    /* without a live quote: EdgeDesk's own detail, only cells that exist */
    if (!c.market && M.available) {
      var cells = [];
      var st = (spec.insights || []).filter(function (i) { return i.family === 'strength'; })[0];
      if (spec.neutral && num(spec.neutral.points) != null) cells.push({ k: 'NEUTRAL-FIELD EDGE', v: [spec.neutral.points < 1.5 ? 'EVEN' : up(spec.neutral.team_short) + ' +' + spec.neutral.points.toFixed(1)], s: 'projection’s team-strength term' });
      if (c.range) cells.push({ k: '80% OUTCOME RANGE', v: c.range, s: 'final margin, 8 in 10 games' });
      cells.push({ k: 'MODEL MONEYLINE', v: [c.away.abbr + ' ' + c.fair_ml.away, c.home.abbr + ' ' + c.fair_ml.home], s: 'model estimate · not a price' });
      var orr = spec.overall_rank;
      if (cells.length < 3 && orr && num(orr.home) != null && num(orr.away) != null) cells.push({ k: orr.label, v: [c.away.abbr + ' #' + orr.away, c.home.abbr + ' #' + orr.home], s: 'of ' + (orr.of || '—') + (spec.league === 'nfl' ? ' NFL teams' : ' FBS teams') });
      c.detail = { title: 'EDGEDESK MODEL DETAIL', note: 'No live sportsbook quote is shown. Every number here is EdgeDesk’s own.', cells: cells.slice(0, 3) };
      void st;
    }
    /* the snapshot's insights as published; home field restated from the numbers (G.homeFieldText) */
    c.insights = (spec.insights || []).slice(0, 6).map(function (i) {
      var hp = i.id === 'home_field' && M.available ? str(i.short).match(G.HOME_FIELD_RE) : null;
      var hf = hp ? G.homeFieldText(M.home_margin, Number(hp[1]), c.home.abbr || c.home.short, c.away.abbr || c.away.short) : null;
      return { icon: i.icon || 'bars', title: up(hf ? hf.title : i.title), text: hf ? hf.text : i.short };
    });
    var conf = spec.confidence || {};
    c.confidence = !M.available ? 'RESEARCH LIMITED' : conf.kind === 'reliability' ? (conf.score != null ? 'RELIABILITY ' + Math.round(conf.score) + '/100' + (conf.grade ? ' · ' + up(String(conf.grade).replace(/_/g, ' ')) : '') : 'RELIABILITY NOT SCORED')
      : up(conf.label || 'DATA CHECK');
    var ds = spec.data || {};
    c.status = !M.available ? 'MODEL: NO PROJECTION' : (ds.status === 'FAULT' ? 'DATA FAULT · RESEARCH ONLY' : (ds.status === 'LIMITED' ? 'MODEL: LIMITED DATA · RESEARCH ONLY' : 'MODEL: ACTIVE · RESEARCH ONLY'));
    c.status_tone = !M.available || ds.status === 'FAULT' ? 'fault' : (ds.status === 'LIMITED' ? 'warn' : 'ok');
    c.fault = ds.status === 'FAULT' ? 'DATA FAULT: ' + (G.FAULT_TEXT[str((ds.faults || [])[0]).split(':')[0]] || 'THE PROJECTION FAILED A CONSISTENCY CHECK') : null;
    c.snapshot_line = (c.started ? 'PREGAME SNAPSHOT · ' : 'SNAPSHOT ') + (G.stamp(M.built_at || spec.generated_at) || '') + (c.snapshot_id ? ' · ' + c.snapshot_id : '') + ' · ' + G.SITE;
    c.tagline = G.TAGLINE;
    /* the copy rule over every string on the graphic */
    var strings = [];
    (function walk(v) { if (v == null) return; if (typeof v === 'string') strings.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (typeof v === 'object') Object.keys(v).forEach(function (k) { walk(v[k]); }); })(c);
    if (strings.some(function (t) { return G.BANNED.test(t); })) return { ok: false, reason: 'copy_rule', message: G.REASON_TEXT.copy_rule };
    return { ok: true, content: c };
  };

  /* a sentence a screen reader can read in place of the picture */
  G.altText = function (c) {
    if (!c) return '';
    if (c.alt) return c.alt;
    var s = 'EdgeDesk research graphic: ' + c.away.name + ' at ' + c.home.name + ', ' + c.date + '. ';
    if (!c.model_available) return s + 'No EdgeDesk projection: ' + c.reason + '.';
    s += 'EdgeDesk projects ' + c.away.short + ' ' + c.scores.away + ', ' + c.home.short + ' ' + c.scores.home + '; fair spread ' + c.spread_text + ', fair total ' + c.total
      + '; model win probability ' + c.away.short + ' ' + c.win.away + ', ' + c.home.short + ' ' + c.win.home + '. ';
    if (c.compare && !c.fault) {
      var CP = c.compare, KC = CP.kalshi || {};
      var parts = CP.cols.map(function (k) {
        return k.head + ' EdgeDesk ' + k.ed.replace(/\s+/g, ' ') + ', ' + (k.win ? 'Kalshi mid' : CP.book_row) + ' ' + k.mk.replace(/\s+/g, ' ') + (k.diff ? ', difference ' + k.diff : '');
      });
      parts.push(KC.available ? KC.diff + ' (percentage points, before fees)' : KC.unavailable + (KC.reason ? ': ' + KC.reason : ''));
      s += (c.edge && c.edge.headline ? 'Edge: ' + c.edge.headline + '. ' : '') + (CP.book_row ? 'EdgeDesk vs the market' : 'EdgeDesk vs Kalshi') + ' (' + CP.times + (CP.note ? ' · ' + CP.note : '') + '): ' + parts.join('; ') + '. '
        + (KC.note ? KC.note + ' ' : '');
    } else if (c.market) s += (c.market.state === 'LIVE' ? 'Current market' : 'Market') + ' (' + c.market.meta + '): ' + c.home.short + ' ' + (c.market.home_spread || '—') + ', total ' + (c.market.total || '—') + '. '
      + (c.edge && c.edge.headline ? 'Edge: ' + c.edge.headline + '. ' : '');
    if (c.insights.length) s += 'What to watch: ' + c.insights.map(function (i) { return str(i.text).replace(/\.$/, ''); }).join('; ') + '. ';
    return s + c.confidence + '. Research, not picks.';
  };
  G.fileName = function (c, format) {
    function slug(t) { return str(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
    return 'edgedesk-' + slug(c.away.short) + '-at-' + slug(c.home.short) + '-' + (format || 'square') + '.png';
  };
  /* the cache key: template + snapshot + the market quote shown + format, and
     the Kalshi block drawn (a price, or "unavailable at model time"; a model-only key is unchanged) */
  G.cacheKey = function (spec, market, format, kalshi) {
    var mk = market && (market.current || MK_OK[market.state]) ? [market.state, market.home_line, market.total, market.ml_home, market.ml_away, market.book, market.captured_at].join('/') : 'model-only';
    var parts = [G.VERSION, G.TEMPLATE, spec && spec.snapshot_id, mk, format || 'square'];
    /* the snapshot's own market line is drawn when no captured quote wins (G.pickMarket) */
    var cs = spec && spec.consensus;
    if (cs) parts.push(['line', cs.home_line, cs.total, cs.ml_home, cs.ml_away, cs.book || cs.label, cs.as_of].join('/'));
    var side = function (s) { return s ? [s.mid, s.spread, s.snapshot_at].join(':') : ''; };
    if (kalshi && (kalshi.state === 'OK' || kalshi.state === 'NO_PRICE')) parts.push(['kalshi', kalshi.state, kalshi.close ? 'close' : 'pre', side(kalshi.away), side(kalshi.home), kalshi.snapshot_at || kalshi.quote_at || '', kalshi.label || ''].join('/'));
    return parts.join('|');
  };

  /* ================================================================ LAYOUT
     measure(text, font) → px. The browser passes the canvas's own; Node uses
     a conservative estimate per family (tests). */
  function approx(text, font) {
    var px = parseFloat(String(font).match(/(\d+(?:\.\d+)?)px/)[1]);
    var cond = /Barlow|Condensed|Narrow/.test(font), w = /\b(7|8|9)00\b/.test(font) ? 1.04 : 1;
    return String(text).length * px * (cond ? 0.5 : 0.58) * w;
  }
  G.approxMeasure = approx;
  function F(size, weight, display, italic) { return (italic ? 'italic ' : '') + (weight || 400) + ' ' + size + 'px ' + (display ? G.DISPLAY : G.BODY); }
  function fitSize(text, size, weight, display, maxW, measure, min) {
    var sz = size;
    while (sz > (min || 12) && measure(text, F(sz, weight, display)) > maxW) sz -= 1;
    return sz;
  }
  function wrap(text, size, weight, display, maxW, measure, maxLines) {
    var words = str(text).split(/\s+/).filter(Boolean), lines = [], cur = '';
    words.forEach(function (w) {
      var t = cur ? cur + ' ' + w : w;
      if (measure(t, F(size, weight, display)) <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; }
    });
    if (cur) lines.push(cur);
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      var last = lines[maxLines - 1];
      while (last.length > 1 && measure(last + '…', F(size, weight, display)) > maxW) last = last.replace(/\s*\S*$/, '') || last.slice(0, -1);
      lines[maxLines - 1] = last + '…';
    }
    return lines;
  }
  /* the largest size (down to min) at which text wraps into maxLines */
  function fitWrap(text, size, weight, display, maxW, measure, maxLines, min) {
    for (var sz = size; sz >= (min || 12); sz--) {
      var l = wrap(text, sz, weight, display, maxW, measure, 99);
      if (l.length <= maxLines) return { size: sz, lines: l };
    }
    return { size: min || 12, lines: wrap(text, min || 12, weight, display, maxW, measure, maxLines) };
  }

  var GEO = {
    square: { header: 118, teams: [120, 396], badge: { r: 86, y: 236, x: 160 }, nameY: 352, recY: 378, center: { away: 182, at: 222, home: 276, date: 320, venue: 348, ctx: 374 },
      panels: [400, 250], strip: [660, 118], watch: [790, 238], footer: 1053, insightSize: 19, insightLines: 3, watchCols: 4, gridCols: 3 },
    portrait: { header: 132, teams: [136, 460], badge: { r: 104, y: 276, x: 172 }, nameY: 420, recY: 450, center: { away: 206, at: 252, home: 314, date: 364, venue: 396, ctx: 426 },
      panels: [470, 282], strip: [764, 138], watch: [914, 358], footer: 1300, insightSize: 23, insightLines: 3, watchCols: 2, gridCols: 2 }
  };

  G.layout = function (c, format, measure) {
    var FMT = G.FORMATS[format] || G.FORMATS.square, W = FMT.w, H = FMT.h, K = G.K, g = GEO[format === 'portrait' ? 'portrait' : 'square'];
    measure = measure || approx;
    var ops = [], P = 24;
    /* width as drawn: the face (italic or not) and any letter spacing */
    function tw(t, size, weight, display, extra) {
      var it = !!(extra && extra.italic), sp = extra && extra.spacing ? extra.spacing : 0;
      return measure(t, F(size, weight, display, it)) + sp * str(t).length;
    }
    function text(t, x, y, size, weight, color, align, maxW, display, min, extra) {
      var sz = size;
      if (maxW) { var lo = min || Math.round(size * 0.55); while (sz > lo && tw(t, sz, weight, display, extra) > maxW) sz -= 1; }
      var o = { type: 'text', text: str(t), x: x, y: y, size: sz, weight: weight || 400, color: color || K.text, align: align || 'left',
        font: F(sz, weight, display), maxW: maxW || null, width: tw(t, sz, weight, display, extra) };
      if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
      ops.push(o);
      return o;
    }
    function rect(x, y, w, h, fill, extra) { var o = { type: 'rect', x: x, y: y, w: w, h: h, fill: fill || null }; if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; }); ops.push(o); return o; }
    function lin(x0, y0, x1, y1, stops) { return { type: 'linear', x0: x0, y0: y0, x1: x1, y1: y1, stops: stops }; }
    function rad(x, y, r, stops) { return { type: 'radial', x0: x, y0: y, r0: 0, x1: x, y1: y, r1: r, stops: stops }; }
    var NEON = function (x, w) { return lin(x, 0, x + w, 0, [[0, K.cyan], [0.55, K.violet], [1, K.magenta]]); };
    function panel(x, y, w, h, title, sub) {
      rect(x, y, w, h, K.panel, { r: 18, stroke: NEON(x, w), lineWidth: 3, glow: { color: 'rgba(64,180,255,0.55)', blur: 18 } });
      if (title) {
        rect(x + 3, y + 3, w - 6, 54, lin(x, y, x, y + 54, [[0, 'rgba(37,99,235,0.55)'], [1, 'rgba(37,99,235,0.15)']]), { r: 15, rTop: true });
        text(title, x + w / 2, y + 40, 30, 800, K.text, 'center', w - 28, true, 18);
      }
      if (sub) text(sub, x + w / 2, y + 74, 15, 600, K.faint, 'center', w - 28, false, 11);
    }

    /* ---- background: night stadium, two light banks, faint yard lines */
    rect(0, 0, W, H, lin(0, 0, 0, H, [[0, K.bg0], [0.45, K.bg1], [1, K.bg2]]));
    rect(0, 0, W, H, rad(110, 40, 420, [[0, 'rgba(160,210,255,0.30)'], [0.35, 'rgba(90,150,255,0.10)'], [1, 'rgba(0,0,0,0)']]));
    rect(0, 0, W, H, rad(W - 110, 40, 420, [[0, 'rgba(160,210,255,0.30)'], [0.35, 'rgba(90,150,255,0.10)'], [1, 'rgba(0,0,0,0)']]));
    ops.push({ type: 'poly', points: [[60, 0], [200, 0], [520, g.teams[1]], [300, g.teams[1]]], fill: lin(0, 0, 0, g.teams[1], [[0, 'rgba(170,215,255,0.10)'], [1, 'rgba(170,215,255,0)']]) });
    ops.push({ type: 'poly', points: [[W - 60, 0], [W - 200, 0], [W - 520, g.teams[1]], [W - 300, g.teams[1]]], fill: lin(0, 0, 0, g.teams[1], [[0, 'rgba(170,215,255,0.10)'], [1, 'rgba(170,215,255,0)']]) });
    /* two banks of floodlights in the top corners */
    [[22, 1], [W - 22, -1]].forEach(function (b) {
      for (var r0 = 0; r0 < 3; r0++) for (var c0 = 0; c0 < 4; c0++) {
        ops.push({ type: 'circle', x: b[0] + b[1] * (c0 * 15), y: 22 + r0 * 15 + c0 * 2, r: 4.2, fill: 'rgba(240,248,255,0.95)', glow: { color: 'rgba(190,225,255,0.95)', blur: 14 } });
      }
    });
    if (c.surface === 'ice') {
      /* a rink seen from above, faint: the centre red line through centre ice */
      var ry = g.teams[1] - 50;
      ops.push({ type: 'line', x0: W / 2 - 160, y0: ry + 10, x1: W / 2 + 160, y1: ry + 10, color: 'rgba(248,113,113,0.07)', width: 5 });
      ops.push({ type: 'circle', x: W / 2, y: ry + 10, r: 66, fill: null, stroke: 'rgba(96,165,250,0.08)', lineWidth: 3 });
    } else if (c.surface === 'court') {
      /* a court seen from above, faint: the half-court line through the centre circle */
      var cy2 = g.teams[1] - 40;
      ops.push({ type: 'line', x0: W / 2 - 240, y0: cy2, x1: W / 2 + 240, y1: cy2, color: 'rgba(251,146,60,0.08)', width: 3 });
      ops.push({ type: 'circle', x: W / 2, y: cy2, r: 72, fill: null, stroke: 'rgba(251,146,60,0.09)', lineWidth: 3 });
      ops.push({ type: 'circle', x: W / 2, y: cy2, r: 24, fill: null, stroke: 'rgba(251,146,60,0.07)', lineWidth: 2 });
    } else {
      for (var yl = 0; yl < 7; yl++) {
        ops.push({ type: 'line', x0: 0, y0: g.teams[1] - 40 + yl * 14, x1: W, y1: g.teams[1] - 40 + yl * 14, color: 'rgba(120,200,160,' + (0.05 - yl * 0.005).toFixed(3) + ')', width: 1 });
      }
    }

    /* ---- header: the EdgeDesk lockup and the league / week label */
    /* the lockup is centred and never reaches the league label, whatever face
       the browser had to fall back to: it shrinks until it fits */
    var tr = W - 100, labW = Math.max(tw(c.league_label, 22, 800, true, { spacing: 3 }), c.week_label ? tw(c.week_label, 22, 800, true, { spacing: 3 }) : 0);
    var maxLock = 2 * (tr - Math.min(labW, 300) - 18 - W / 2);
    var markR = format === 'portrait' ? 46 : 42, wordSize = format === 'portrait' ? 74 : 66, edgeW, deskW, lockW;
    for (;;) {
      edgeW = measure('EDGE', F(wordSize, 800, true, true)) + 4; deskW = measure('DESK', F(wordSize, 800, true, true));
      lockW = markR * 2 + 22 + edgeW + deskW;
      if (lockW <= maxLock || wordSize <= 36) break;
      wordSize -= 2; markR = Math.max(30, Math.round(wordSize * 0.62));
    }
    var lx = (W - lockW) / 2, ly = format === 'portrait' ? 66 : 60;
    ops.push({ type: 'circle', x: lx + markR, y: ly, r: markR, fill: 'rgba(6,12,30,0.95)', stroke: lin(lx, ly - markR, lx + 2 * markR, ly + markR, [[0, K.cyan], [1, K.magenta]]), lineWidth: 6, glow: { color: 'rgba(80,190,255,0.8)', blur: 22 } });
    text('ED', lx + markR, ly + markR * 0.36, Math.round(markR * 0.98), 800, lin(lx, 0, lx + 2 * markR, 0, [[0, K.cyan], [1, K.magenta]]), 'center', null, true, null, { italic: true });
    var wx = lx + markR * 2 + 22;
    text('EDGE', wx, ly + wordSize * 0.25, wordSize, 800, K.text, 'left', null, true, null, { italic: true });
    text('DESK', wx + edgeW, ly + wordSize * 0.25, wordSize, 800, lin(wx + edgeW, 0, wx + edgeW + deskW, 0, [[0, K.cyan], [1, K.magenta]]), 'left', null, true, null, { italic: true });
    text(c.tagline, wx + 4, ly + wordSize * 0.25 + 30, 17, 600, K.dim, 'left', edgeW + deskW, false, 12, { spacing: 5 });
    text(c.league_label, tr, 46, 22, 800, K.text, 'right', 300, true, 14, { spacing: 3 });
    if (c.week_label) text(c.week_label, tr, 74, 22, 800, K.text, 'right', 300, true, 14, { spacing: 3 });
    rect(tr - 110, c.week_label ? 84 : 56, 110, 4, lin(tr - 110, 0, tr, 0, [[0, K.gold], [1, 'rgba(250,204,21,0.2)']]), { r: 2 });

    /* ---- the two teams: monogram badges in team colours, names in the middle */
    function badge(t, cx, cy, r) {
      ops.push({ type: 'circle', x: cx, y: cy, r: r + 12, fill: null, stroke: lin(cx - r, cy - r, cx + r, cy + r, [[0, K.cyan], [1, K.magenta]]), lineWidth: 4, glow: { color: 'rgba(80,190,255,0.7)', blur: 26 } });
      ops.push({ type: 'circle', x: cx, y: cy, r: r, fill: rad(cx - r * 0.35, cy - r * 0.45, r * 1.6, [[0, lighten(t.color, 0.28)], [0.6, t.color], [1, darken(t.color, 0.35)]]), stroke: t.alt, lineWidth: 8 });
      ops.push({ type: 'circle', x: cx, y: cy, r: r - 14, fill: null, stroke: 'rgba(255,255,255,0.18)', lineWidth: 2 });
      var ab = t.abbr || '?';
      text(ab, cx, cy + r * 0.24, Math.round(r * (ab.length <= 3 ? 0.78 : 0.62)), 800, t.on, 'center', r * 1.55, true, 20, { shadow: { color: 'rgba(0,0,0,0.45)', blur: 8 } });
    }
    var bx = g.badge.x, by = g.badge.y, br = g.badge.r;
    badge(c.away, bx, by, br);
    badge(c.home, W - bx, by, br);
    [['away', bx], ['home', W - bx]].forEach(function (s) {
      var t = c[s[0]];
      text((t.rank ? t.rank + ' ' : '') + t.short, s[1], g.nameY, format === 'portrait' ? 32 : 28, 800, K.text, 'center', 300, true, 16);
      if (t.record) text(t.record, s[1], g.recY, format === 'portrait' ? 26 : 22, 600, K.dim, 'center', 240, true, 14);
    });
    var cw = W - 2 * (bx + br + 26);
    text(c.away.name, W / 2, g.center.away, format === 'portrait' ? 70 : 62, 800, K.text, 'center', cw, true, 26, { shadow: { color: 'rgba(0,0,0,0.6)', blur: 10 } });
    text('AT', W / 2, g.center.at, format === 'portrait' ? 34 : 30, 800, K.cyan, 'center', null, true);
    text(c.home.name, W / 2, g.center.home, format === 'portrait' ? 70 : 62, 800, K.text, 'center', cw, true, 26, { shadow: { color: 'rgba(0,0,0,0.6)', blur: 10 } });
    text(c.date, W / 2, g.center.date, format === 'portrait' ? 32 : 28, 700, '#9fd8ff', 'center', cw, true, 16);
    if (c.venue) text(c.venue, W / 2, g.center.venue, format === 'portrait' ? 24 : 22, 600, K.dim, 'center', cw, true, 14);
    if (c.context) text(c.context, W / 2, g.center.ctx, format === 'portrait' ? 22 : 20, 600, K.faint, 'center', cw, true, 13);

    /* ---- the three model panels */
    var py = g.panels[0], ph = g.panels[1], lw = 340, cwid = W - 2 * P - 2 * lw - 24, rx = W - P - lw, cx0 = P + lw + 12;
    /* the panel words: football's unless the content names its own (another sport) */
    var LB = c.labels || {};
    if (c.model_available) {
      panel(P, py, lw, ph, LB.left || 'FAIR SPREAD', LB.left_sub || 'EDGEDESK MODEL · NOT A SPORTSBOOK LINE');
      text(c.spread_team, P + lw / 2, py + 120, 32, 800, K.dim, 'center', lw - 40, true, 16);
      text(c.spread_value, P + lw / 2, py + (format === 'portrait' ? 210 : 196), format === 'portrait' ? 110 : 96, 800, K.text, 'center', lw - 40, true, 40, { shadow: { color: 'rgba(42,212,255,0.45)', blur: 18 } });
      var favWin = c.fav_side ? c.win[c.fav_side] : c.win.home;
      text(favWin + ' MODEL WIN PROBABILITY', P + lw / 2, py + ph - 22, 19, 700, K.green, 'center', lw - 30, false, 12);

      panel(cx0, py, cwid, ph, LB.center || 'PROJECTED SCORE', LB.center_sub || 'EDGEDESK PROJECTION');
      var half = cwid / 2, sy = py + (format === 'portrait' ? 108 : 100), scoreSz = c.scores.whole || c.scores.big ? (format === 'portrait' ? 86 : 70) : 52;
      [['away', cx0 + half / 2], ['home', cx0 + half + half / 2]].forEach(function (s) {
        var t = c[s[0]];
        text(t.abbr, s[1], sy, 24, 800, K.dim, 'center', half - 20, true, 14);
        text(c.scores[s[0]], s[1], sy + (format === 'portrait' ? 84 : 72), scoreSz, 800, K.text, 'center', half - 16, true, 30);
      });
      ops.push({ type: 'line', x0: cx0 + half, y0: sy - 20, x1: cx0 + half, y1: sy + (format === 'portrait' ? 86 : 74), color: K.line, width: 2 });
      /* the win-probability bar, coloured by team, percentages at its ends */
      var barY = py + ph - 44, barX = cx0 + 22, barW = cwid - 44;
      text('WIN PROBABILITY', cx0 + cwid / 2, barY - 8, 14, 700, K.faint, 'center', barW, false, 10, { spacing: 2 });
      rect(barX, barY, barW * c.win.away_pct / 100, 16, c.away.bar || c.away.color, { r: 8, rRight: c.win.away_pct >= 99 ? false : 'none', stroke: 'rgba(255,255,255,0.25)', lineWidth: 1 });
      rect(barX + barW * c.win.away_pct / 100, barY, barW * c.win.home_pct / 100, 16, c.home.bar || c.home.color, { r: 8, rLeft: 'none', stroke: 'rgba(255,255,255,0.25)', lineWidth: 1 });
      text(c.away.abbr + ' ' + c.win.away, barX, barY + 35, 22, 800, c.fav_side === 'away' ? K.green : K.dim, 'left', barW / 2 - 6, true, 12);
      text(c.home.abbr + ' ' + c.win.home, barX + barW, barY + 35, 22, 800, c.fav_side === 'home' ? K.green : K.dim, 'right', barW / 2 - 6, true, 12);

      panel(rx, py, lw, ph, LB.right || 'FAIR TOTAL', LB.right_sub || 'EDGEDESK MODEL · NOT A SPORTSBOOK LINE');
      text(c.total, rx + lw / 2, py + (format === 'portrait' ? 182 : 170), format === 'portrait' ? 110 : 96, 800, K.text, 'center', lw - 40, true, 40, { shadow: { color: 'rgba(224,64,251,0.4)', blur: 18 } });
      var tsub = c.total_sub || { label: 'PROJECTED POINTS', text: null };
      text(tsub.label, rx + lw / 2, py + ph - 52, 15, 700, K.faint, 'center', lw - 30, false, 11, { spacing: 2 });
      text(tsub.text || (c.away.abbr + ' ' + c.points.away + '  ·  ' + c.home.abbr + ' ' + c.points.home), rx + lw / 2, py + ph - 20, 24, 800, K.green, 'center', lw - 30, true, 14);
    } else {
      var nh = g.watch[0] + g.watch[1] - py;
      panel(P, py, W - 2 * P, nh, 'NO EDGEDESK PROJECTION');
      ops.push({ type: 'icon', name: 'alert', x: W / 2 - 32, y: py + 110, size: 64, color: K.warn });
      var nl = fitWrap(c.reason.charAt(0).toUpperCase() + c.reason.slice(1) + '. EdgeDesk shows a research limitation rather than an estimate it cannot support.', 32, 600, false, W - 2 * P - 120, measure, 4, 18);
      nl.lines.forEach(function (l, i) { text(l, W / 2, py + 240 + i * (nl.size + 14), nl.size, 600, K.dim, 'center'); });
      text('No projected score, spread, total or win probability is shown for this game.', W / 2, py + nh - 40, 20, 500, K.faint, 'center', W - 2 * P - 60, false, 12);
    }

    /* ---- the strip: a LIVE market, or EdgeDesk's own detail */
    var sy0 = g.strip[0], sh = g.strip[1], sw = W - 2 * P;
    if (c.fault) {
      rect(P, sy0, sw, sh, 'rgba(60,12,18,0.92)', { r: 16, stroke: K.fault, lineWidth: 3, glow: { color: 'rgba(248,113,113,0.5)', blur: 16 } });
      ops.push({ type: 'icon', name: 'alert', x: P + 26, y: sy0 + sh / 2 - 22, size: 44, color: K.fault });
      text(c.fault, P + 90, sy0 + 44, 28, 800, K.fault, 'left', sw - 120, true, 16);
      var fl = wrap('These numbers failed EdgeDesk’s own consistency checks. Read them as research only until the next snapshot passes.', 18, 500, false, sw - 120, measure, 2);
      fl.forEach(function (l, i) { text(l, P + 90, sy0 + 76 + i * 24, 18, 500, K.dim, 'left'); });
    } else if (c.compare) {
      /* EDGEDESK vs KALSHI (vs MARKET with a live book): a label column, then
         one column per market. Five lines: the heads; EdgeDesk; the market;
         the difference (the book's under its own columns, Kalshi's as one
         sentence across its columns); both times, with the large-gap note
         beside them when there is one. Kalshi unavailable at the model's
         time: its message takes Kalshi's place and nothing of Kalshi's is
         compared. The table takes most of the gaps either side of the strip. */
      var CP = c.compare, KC = CP.kalshi || {}, sq = format !== 'portrait', ty = sy0 - (sq ? 4 : 6), th = sh + (sq ? 8 : 12);
      rect(P, ty, sw, th, K.panel, { r: 16, stroke: NEON(P, sw), lineWidth: 2, glow: { color: 'rgba(64,180,255,0.35)', blur: 12 } });
      var ry = (sq ? [26, 50, 74, 98, 119] : [30, 60, 90, 120, 143]).map(function (v) { return ty + v; });
      var tone = [K.text, K.dim, K.cyan], lw2 = 290, dx = P + 24 + lw2, dw = sw - 24 - lw2 - 14;
      var bookC = CP.cols.filter(function (x) { return !x.win; }), kC = KC.available ? CP.cols.filter(function (x) { return x.win; }) : [];
      /* the unavailable message takes two columns' room */
      var kn = KC.available ? kC.length : 2, nC = bookC.length + kn;
      var cw2 = Math.min(dw / Math.max(nC, 1), 250), x0 = dx + (dw - cw2 * nC) / 2, kx = x0 + bookC.length * cw2, kw = kn * cw2;
      text(CP.title, P + 24, ry[0], 22, 800, CP.edge ? K.green : K.text, 'left', lw2 - 14, true, 14);
      ops.push({ type: 'line', x0: P + 20, y0: ry[0] + 9, x1: W - P - 20, y1: ry[0] + 9, color: K.line, width: 1 });
      if (bookC.length || KC.available) CP.rows.forEach(function (r, i) { if (r) text(r, P + 24, ry[i + 1], 16, 700, tone[i], 'left', lw2 - 14, true, 10, { spacing: 1 }); });
      bookC.concat(kC).forEach(function (col, i) {
        var x = x0 + i * cw2, cx = x + cw2 / 2;
        /* a rule between two Kalshi columns stops above the sentence that spans them */
        ops.push({ type: 'line', x0: x, y0: ty + 12, x1: x, y1: i > bookC.length ? ry[2] + 8 : ry[3] + 6, color: K.line, width: 2 });
        text(col.head, cx, ry[0], 13, 700, K.faint, 'center', cw2 - 12, false, 9, { spacing: 2 });
        text(col.ed, cx, ry[1], sq ? 22 : 24, 800, tone[0], 'center', cw2 - 12, true, 12);
        text(col.mk, cx, ry[2], sq ? 22 : 24, 800, tone[1], 'center', cw2 - 12, true, 12);
        if (col.diff) text(col.diff, cx, ry[3], sq ? 20 : 22, 800, tone[2], 'center', cw2 - 12, true, 11);
      });
      if (KC.available) text(KC.diff, kx + kw / 2, ry[3], sq ? 20 : 22, 800, K.cyan, 'center', kw - 12, true, 11);
      else {
        /* beside a live book's columns, in Kalshi's place; alone, across the strip */
        var ux = bookC.length ? kx + kw / 2 : W / 2, uw = bookC.length ? kw - 16 : sw - 80;
        if (bookC.length) ops.push({ type: 'line', x0: kx, y0: ty + 12, x1: kx, y1: ry[3] + 6, color: K.line, width: 2 });
        text(KC.unavailable, ux, ry[1] + (sq ? 12 : 14), sq ? 26 : 28, 800, K.warn, 'center', uw, true, 14);
        if (KC.reason) text(KC.reason, ux, ry[2] + (sq ? 16 : 20), 16, 600, K.dim, 'center', uw, false, 11);
      }
      var tm = text(CP.times, P + 24, ry[4], 14, 600, K.faint, 'left', sw - 48, false, 10);
      if (KC.note) text(KC.note, W - P - 20, ry[4], 14, 700, K.warn, 'right', sw - 48 - Math.min(tm.width, sw - 48) - 24, false, 10);
    } else if (c.market) {
      rect(P, sy0, sw, sh, K.panel, { r: 16, stroke: NEON(P, sw), lineWidth: 2, glow: { color: 'rgba(64,180,255,0.35)', blur: 12 } });
      text(c.market.title, P + 24, sy0 + 34, 26, 800, K.text, 'left', 280, true, 16);
      text(c.market.meta, P + 24, sy0 + 58, 15, 600, K.faint, 'left', 330, false, 11);
      /* only the markets the quote carries: no empty column, no dash standing in for a price */
      var cols = [];
      if (c.market.home_spread) cols.push([LB.market_spread || 'SPREAD', c.away.abbr + ' ' + c.market.away_spread, c.home.abbr + ' ' + c.market.home_spread]);
      if (c.market.total) cols.push(['TOTAL', c.market.total, c.market.total_prices || '']);
      if (c.market.away_ml && c.market.home_ml) cols.push(['MONEYLINE', c.away.abbr + ' ' + c.market.away_ml, c.home.abbr + ' ' + c.market.home_ml]);
      var colX = P + 360, colW = (sw - 360 - 300) / Math.max(cols.length, 1);
      cols.forEach(function (col, i) {
        var x = colX + i * colW + colW / 2;
        text(col[0], x, sy0 + 30, 15, 700, K.faint, 'center', colW - 10, false, 10, { spacing: 2 });
        text(col[1], x, sy0 + 62, 24, 800, K.text, 'center', colW - 10, true, 12);
        if (col[2]) text(col[2], x, sy0 + 92, 24, 800, K.text, 'center', colW - 10, true, 12);
      });
      if (c.market.no_vig) text('NO-VIG WIN %  ' + c.away.abbr + ' ' + c.market.no_vig.away + ' · ' + c.home.abbr + ' ' + c.market.no_vig.home, P + 24, sy0 + sh - 18, 15, 700, K.green, 'left', 330, false, 10);
      var vx = W - P - 290;
      ops.push({ type: 'line', x0: vx - 14, y0: sy0 + 16, x1: vx - 14, y1: sy0 + sh - 16, color: K.line, width: 2 });
      if (c.edge && c.edge.headline) text('EDGE: ' + c.edge.headline, vx, sy0 + 30, 22, 800, K.green, 'left', 276, true, 12);
      else text('VS EDGEDESK', vx, sy0 + 30, 15, 700, K.faint, 'left', 270, false, 10, { spacing: 2 });
      c.market.vs.forEach(function (v, i) { text(v, vx, sy0 + 60 + i * 30, 19, 600, K.dim, 'left', 276, false, 11); });
      if (c.market.note) text(c.market.note, vx, sy0 + sh - 8, 12, 700, K.faint, 'left', 276, false, 9, { spacing: 1 });
    } else if (c.detail) {
      rect(P, sy0, sw, sh, K.panel, { r: 16, stroke: NEON(P, sw), lineWidth: 2, glow: { color: 'rgba(64,180,255,0.35)', blur: 12 } });
      text(c.detail.title, P + 24, sy0 + 34, 24, 800, K.text, 'left', 300, true, 14);
      var dn = wrap(c.detail.note, 14, 500, false, 300, measure, 3);
      dn.forEach(function (l, i) { text(l, P + 24, sy0 + 58 + i * 19, 14, 500, K.faint, 'left', 300, false, 10); });
      var n = c.detail.cells.length, cx1 = P + 340, cw1 = (sw - 340) / Math.max(n, 1);
      c.detail.cells.forEach(function (cell, i) {
        var x = cx1 + i * cw1;
        if (i) ops.push({ type: 'line', x0: x, y0: sy0 + 16, x1: x, y1: sy0 + sh - 16, color: K.line, width: 2 });
        text(cell.k, x + cw1 / 2, sy0 + 32, 15, 700, K.faint, 'center', cw1 - 20, false, 10, { spacing: 2 });
        /* one value per line, each fitted to the cell */
        var vs = Array.isArray(cell.v) ? cell.v : [cell.v], vsz = vs.length > 1 ? 26 : 30;
        vs.forEach(function (l, j) { text(l, x + cw1 / 2, sy0 + 66 + j * (vsz + 2) - (vs.length - 1) * 12, vsz, 800, K.text, 'center', cw1 - 20, true, 12); });
        text(cell.s, x + cw1 / 2, sy0 + sh - 16, 14, 500, K.faint, 'center', cw1 - 20, false, 10);
      });
    }

    /* ---- what to watch for: 2-4 measured insights, never filler */
    var wy = g.watch[0], wh = g.watch[1];
    if (c.insights.length) {
      rect(P, wy, sw, wh, K.panel, { r: 18, stroke: lin(P, 0, P + sw, 0, [[0, K.blue], [0.5, K.violet], [1, K.magenta]]), lineWidth: 3, glow: { color: 'rgba(160,90,255,0.45)', blur: 16 } });
      text('WHAT TO WATCH FOR', W / 2, wy + 40, 34, 800, K.text, 'center', sw - 40, true, 18);
      var n2 = c.insights.length;
      if (n2 > 4) {
        /* five or six: a grid (three across square, two across portrait), each
           cell an icon and title on one line and the measured line under them */
        var gc = g.gridCols, gr = Math.ceil(n2 / gc), cw3 = (sw - 20) / gc, ch3 = (wh - 58) / gr, pt = format === 'portrait';
        c.insights.forEach(function (ins, i) {
          var col = i % gc, row = Math.floor(i / gc), x = P + 10 + col * cw3, y = wy + 54 + row * ch3, tone = [K.blue, K.magenta, K.cyan, K.magenta, K.blue, K.cyan][i % 6];
          if (col) ops.push({ type: 'line', x0: x, y0: y + 8, x1: x, y1: y + ch3 - 8, color: K.line, width: 2 });
          if (row) ops.push({ type: 'line', x0: x + 14, y0: y, x1: x + cw3 - 14, y1: y, color: K.line, width: 1 });
          var isz = pt ? 32 : 26, ty3 = y + (pt ? 32 : 26);
          ops.push({ type: 'icon', name: ins.icon, x: x + 14, y: ty3 - isz + 4, size: isz, color: tone });
          text(ins.title, x + 14 + isz + 10, ty3, pt ? 25 : 20, 800, K.text, 'left', cw3 - isz - 40, true, 12);
          var top3 = ty3 + (pt ? 26 : 21), room3 = y + ch3 - 6 - top3, b3 = null;
          for (var sz3 = pt ? 21 : 17; sz3 >= 13 && !b3; sz3--) {
            var cap3 = Math.max(1, Math.floor((room3 + 2) / (sz3 + 4)) + 1), l3 = wrap(ins.text, sz3, 500, false, cw3 - 28, measure, 99);
            if (l3.length <= cap3) b3 = { size: sz3, lines: l3 };
          }
          if (!b3) b3 = { size: 13, lines: wrap(ins.text, 13, 500, false, cw3 - 28, measure, Math.max(1, Math.floor((room3 + 2) / 17) + 1)) };
          b3.lines.forEach(function (l, j) { text(l, x + 14, top3 + j * (b3.size + 4), b3.size, 500, K.dim, 'left'); });
        });
      }
      var colsN = format === 'portrait' ? (n2 === 4 ? 2 : 1) : n2;
      var rowsN = Math.ceil(n2 / colsN), gw = (sw - 20) / colsN, gh = (wh - 60) / rowsN;
      if (n2 <= 4) c.insights.forEach(function (ins, i) {
        var col = i % colsN, row = Math.floor(i / colsN), x = P + 10 + col * gw, y = wy + 56 + row * gh;
        if (col) ops.push({ type: 'line', x0: x, y0: y + 10, x1: x, y1: y + gh - 10, color: K.line, width: 2 });
        if (row) ops.push({ type: 'line', x0: x + 16, y0: y, x1: x + gw - 16, y1: y, color: K.line, width: 1 });
        var iconS = format === 'portrait' ? 40 : 34, tone = [K.blue, K.magenta, K.cyan, K.magenta][i % 4];
        if (format === 'portrait') {
          var oneCol = colsN === 1, maxL = oneCol ? Math.max(1, Math.floor((gh - 58) / (g.insightSize + 7))) : g.insightLines;
          ops.push({ type: 'icon', name: ins.icon, x: x + 22, y: y + 12, size: iconS, color: tone });
          text(ins.title, x + 22 + iconS + 14, y + 42, 26, 800, K.text, 'left', gw - iconS - 60, true, 14);
          /* the largest size whose lines stay inside this cell's row */
          var bl = null;
          for (var szp = g.insightSize; szp >= 15 && !bl; szp--) {
            var capp = Math.min(maxL, Math.max(1, Math.floor((gh - 86) / (szp + 7)) + 1)), tl = wrap(ins.text, szp, 500, false, gw - 50, measure, 99);
            if (tl.length <= capp) bl = { size: szp, lines: tl };
          }
          if (!bl) bl = fitWrap(ins.text, 15, 500, false, gw - 50, measure, Math.max(1, Math.floor((gh - 86) / 22) + 1), 15);
          bl.lines.forEach(function (l, j) { text(l, x + 22, y + 78 + j * (bl.size + 7), bl.size, 500, K.dim, 'left'); });
        } else {
          iconS = 30;
          ops.push({ type: 'icon', name: ins.icon, x: x + gw / 2 - iconS / 2, y: y - 2, size: iconS, color: tone });
          text(ins.title, x + gw / 2, y + iconS + 22, 21, 800, K.text, 'center', gw - 22, true, 13);
          /* as many lines as the panel holds below the title, at the largest size that fits */
          var top2 = y + iconS + 46, room = wy + wh - 10 - top2;
          var b2 = null;
          for (var sz2 = g.insightSize; sz2 >= 14; sz2--) {
            var cap2 = Math.max(1, Math.floor((room + 4) / (sz2 + 4)) + 0);
            var t2 = wrap(ins.text, sz2, 500, false, gw - 26, measure, 99);
            if (t2.length <= Math.min(cap2, g.insightLines + 1)) { b2 = { size: sz2, lines: t2 }; break; }
          }
          if (!b2) b2 = { size: 14, lines: wrap(ins.text, 14, 500, false, gw - 26, measure, Math.max(1, Math.floor((room + 4) / 18))) };
          b2.lines.forEach(function (l, j) { text(l, x + gw / 2, top2 + j * (b2.size + 4), b2.size, 500, K.dim, 'center'); });
        }
      });
    }

    /* ---- footer: what the numbers rest on, the status, the snapshot */
    var fy = g.footer;
    var toneC = c.status_tone === 'fault' ? K.fault : (c.status_tone === 'warn' ? K.warn : K.cyan);
    var co = text(c.confidence, P + 6, fy, 20, 700, K.cyan, 'left', 360, true, 12, { spacing: 1 });
    var cwid2 = Math.min(co.width, 360);
    ops.push({ type: 'line', x0: P + 20 + cwid2, y0: fy - 17, x1: P + 20 + cwid2, y1: fy + 3, color: 'rgba(255,255,255,0.5)', width: 2 });
    text(c.status, P + 34 + cwid2, fy, 20, 700, toneC, 'left', W - 2 * P - cwid2 - 330, true, 11, { spacing: 1 });
    text(c.snapshot_line, P + 6, fy + 22, 13, 500, K.faint, 'left', W - 2 * P - 300, false, 9);
    var pw = 270, phh = 44;
    rect(W - P - pw, fy - 24, pw, phh, lin(0, fy - 24, 0, fy + 20, [[0, '#fde047'], [1, '#eab308']]), { r: 10, glow: { color: 'rgba(250,204,21,0.45)', blur: 14 } });
    text(c.tagline, W - P - pw / 2, fy + 7, 24, 800, K.ink, 'center', pw - 20, true, 14);
    return { width: W, height: H, format: format === 'portrait' ? 'portrait' : 'square', ops: ops };
  };

  /* colour helpers for the badge's lit sphere */
  function rgb(h) { h = str(h).replace('#', ''); if (!/^[0-9a-f]{6}$/i.test(h)) h = '3b4a6b'; return [parseInt(h.substr(0, 2), 16), parseInt(h.substr(2, 2), 16), parseInt(h.substr(4, 2), 16)]; }
  function hx(a) { return '#' + a.map(function (v) { v = Math.max(0, Math.min(255, Math.round(v))); return ('0' + v.toString(16)).slice(-2); }).join(''); }
  function lighten(h, t) { var c = rgb(h); return hx(c.map(function (v) { return v + (255 - v) * t; })); }
  function darken(h, t) { var c = rgb(h); return hx(c.map(function (v) { return v * (1 - t); })); }
  G._lighten = lighten; G._darken = darken;

  /* ================================================================ DRAW */
  function paintOf(g, f) {
    if (!f || typeof f === 'string') return f;
    var gr = f.type === 'radial' ? g.createRadialGradient(f.x0, f.y0, f.r0, f.x1, f.y1, f.r1) : g.createLinearGradient(f.x0, f.y0, f.x1, f.y1);
    f.stops.forEach(function (s) { gr.addColorStop(s[0], s[1]); });
    return gr;
  }
  function roundRect(g, o) {
    var r = o.r || 0, x = o.x, y = o.y, w = o.w, h = o.h;
    var tl = r, tr = r, br = r, bl = r;
    if (o.rTop) { br = 0; bl = 0; }
    if (o.rLeft === 'none') { tl = 0; bl = 0; }
    if (o.rRight === 'none') { tr = 0; br = 0; }
    g.beginPath();
    g.moveTo(x + tl, y); g.lineTo(x + w - tr, y); if (tr) g.arcTo(x + w, y, x + w, y + tr, tr); else g.lineTo(x + w, y);
    g.lineTo(x + w, y + h - br); if (br) g.arcTo(x + w, y + h, x + w - br, y + h, br); else g.lineTo(x + w, y + h);
    g.lineTo(x + bl, y + h); if (bl) g.arcTo(x, y + h, x, y + h - bl, bl); else g.lineTo(x, y + h);
    g.lineTo(x, y + tl); if (tl) g.arcTo(x, y, x + tl, y, tl); else g.lineTo(x, y);
    g.closePath();
  }
  function withGlow(g, glow, fn) {
    g.save();
    if (glow) { g.shadowColor = glow.color; g.shadowBlur = glow.blur; }
    fn();
    g.restore();
  }
  G.ICON = function (g, name, x, y, s, color) {
    g.save(); g.translate(x, y); g.scale(s / 32, s / 32);
    g.fillStyle = color; g.strokeStyle = color; g.lineWidth = 2.6; g.lineJoin = 'round'; g.lineCap = 'round';
    g.shadowColor = color; g.shadowBlur = 10;
    function rr(a, b, w, h, r) { roundRect(g, { x: a, y: b, w: w, h: h, r: r }); g.fill(); }
    switch (name) {
      case 'bars': rr(3, 18, 7, 12, 1.5); rr(12.5, 10, 7, 20, 1.5); rr(22, 2, 7, 28, 1.5); break;
      case 'home': g.beginPath(); g.moveTo(16, 2); g.lineTo(31, 15); g.lineTo(27, 15); g.lineTo(27, 30); g.lineTo(19.5, 30); g.lineTo(19.5, 21); g.lineTo(12.5, 21); g.lineTo(12.5, 30); g.lineTo(5, 30); g.lineTo(5, 15); g.lineTo(1, 15); g.closePath(); g.fill(); break;
      case 'shield': g.beginPath(); g.moveTo(16, 1.5); g.lineTo(29, 6); g.quadraticCurveTo(29, 23, 16, 30.5); g.quadraticCurveTo(3, 23, 3, 6); g.closePath(); g.stroke();
        g.beginPath(); g.moveTo(16, 6); g.lineTo(24.5, 9); g.quadraticCurveTo(24, 20.5, 16, 25.5); g.closePath(); g.fill(); break;
      case 'ball': g.save(); g.translate(16, 16); g.rotate(-Math.PI / 4); g.beginPath(); g.ellipse(0, 0, 14.5, 8.5, 0, 0, Math.PI * 2); g.stroke();
        g.beginPath(); g.moveTo(-6, 0); g.lineTo(6, 0); [-3.5, 0, 3.5].forEach(function (k) { g.moveTo(k, -2.6); g.lineTo(k, 2.6); }); g.stroke(); g.restore(); break;
      case 'run': g.beginPath(); g.arc(21, 5, 3.4, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.moveTo(9, 12); g.lineTo(17, 10); g.lineTo(23, 15); g.lineTo(28, 15); g.moveTo(17, 10); g.lineTo(14, 19); g.lineTo(20, 23); g.lineTo(18, 30); g.moveTo(14, 19); g.lineTo(9, 25); g.lineTo(3, 25); g.stroke();
        g.beginPath(); g.moveTo(1, 11); g.lineTo(6, 11); g.moveTo(0, 16); g.lineTo(5, 16); g.stroke(); break;
      case 'people': [[16, 8, 4.6, 7, 18, 18, 12], [6.5, 11, 3.6, 1, 20, 11, 10], [25.5, 11, 3.6, 20, 20, 11, 10]].forEach(function (p) {
          g.beginPath(); g.arc(p[0], p[1], p[2], 0, Math.PI * 2); g.fill(); rr(p[3], p[4], p[5], p[6], 4.5); }); break;
      case 'bolt': g.beginPath(); g.moveTo(19, 1); g.lineTo(5, 18); g.lineTo(14.5, 18); g.lineTo(12, 31); g.lineTo(27, 13); g.lineTo(17.5, 13); g.closePath(); g.fill(); break;
      case 'cloud': g.beginPath(); g.arc(11, 17, 6.5, Math.PI * 0.5, Math.PI * 1.5); g.arc(17, 10.5, 8, Math.PI, Math.PI * 1.9); g.arc(24, 16.5, 6, Math.PI * 1.45, Math.PI * 0.5); g.closePath(); g.fill();
        g.beginPath(); [10, 16, 22].forEach(function (k) { g.moveTo(k, 26); g.lineTo(k - 2, 31); }); g.stroke(); break;
      case 'alert': g.beginPath(); g.moveTo(16, 2); g.lineTo(31, 29); g.lineTo(1, 29); g.closePath(); g.stroke(); rr(14.6, 11, 2.8, 10, 1.2); g.beginPath(); g.arc(16, 24.6, 1.8, 0, Math.PI * 2); g.fill(); break;
      case 'clock': g.beginPath(); g.arc(16, 16, 13.5, 0, Math.PI * 2); g.stroke(); g.beginPath(); g.moveTo(16, 8); g.lineTo(16, 16); g.lineTo(22, 20); g.stroke(); break;
      case 'helmet': g.beginPath(); g.moveTo(3, 20); g.quadraticCurveTo(2, 4, 17, 3); g.quadraticCurveTo(30, 3, 30, 17); g.lineTo(30, 24); g.lineTo(19, 24); g.lineTo(17, 28); g.lineTo(8, 28); g.quadraticCurveTo(3, 27, 3, 20); g.closePath(); g.fill();
        g.strokeStyle = '#0b1020'; g.shadowBlur = 0; g.lineWidth = 2; g.beginPath(); g.moveTo(21, 15); g.lineTo(31, 15); g.moveTo(24, 15); g.lineTo(24, 24); g.stroke(); break;
      case 'puck': g.beginPath(); g.ellipse(16, 12, 13, 5.5, 0, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.moveTo(3, 12); g.lineTo(3, 20); g.ellipse(16, 20, 13, 5.5, 0, Math.PI, 0, true); g.lineTo(29, 12); g.closePath(); g.fill(); break;
      case 'net': g.beginPath(); g.moveTo(3, 29); g.lineTo(3, 9); g.quadraticCurveTo(3, 3, 9, 3); g.lineTo(23, 3); g.quadraticCurveTo(29, 3, 29, 9); g.lineTo(29, 29); g.stroke();
        g.lineWidth = 1.4; g.beginPath(); [9, 16, 23].forEach(function (k) { g.moveTo(k, 4); g.lineTo(k, 29); }); [10, 17, 24].forEach(function (k) { g.moveTo(4, k); g.lineTo(28, k); }); g.stroke(); break;
      case 'hoop': g.beginPath(); g.arc(16, 16, 13.5, 0, Math.PI * 2); g.stroke();
        g.beginPath(); g.moveTo(2.5, 16); g.lineTo(29.5, 16); g.moveTo(16, 2.5); g.lineTo(16, 29.5);
        g.moveTo(7, 5.5); g.quadraticCurveTo(12.5, 16, 7, 26.5); g.moveTo(25, 5.5); g.quadraticCurveTo(19.5, 16, 25, 26.5); g.stroke(); break;
      case 'flag': g.beginPath(); g.moveTo(6, 30); g.lineTo(6, 3); g.stroke();
        g.beginPath(); g.moveTo(7, 4); g.quadraticCurveTo(13, 1, 18, 5); g.quadraticCurveTo(23, 9, 29, 6); g.lineTo(29, 18); g.quadraticCurveTo(23, 21, 18, 17); g.quadraticCurveTo(13, 13, 7, 16); g.closePath(); g.fill(); break;
      case 'plane': g.save(); g.translate(16, 16); g.rotate(Math.PI / 4); g.beginPath();
        g.moveTo(0, -14); g.quadraticCurveTo(2.2, -12, 2.2, -6); g.lineTo(13, 2); g.lineTo(13, 5); g.lineTo(2.2, 1); g.lineTo(2, 9); g.lineTo(6, 12); g.lineTo(6, 14);
        g.lineTo(0, 12.5); g.lineTo(-6, 14); g.lineTo(-6, 12); g.lineTo(-2, 9); g.lineTo(-2.2, 1); g.lineTo(-13, 5); g.lineTo(-13, 2); g.lineTo(-2.2, -6); g.quadraticCurveTo(-2.2, -12, 0, -14);
        g.closePath(); g.fill(); g.restore(); break;
      case 'mountain': g.beginPath(); g.moveTo(1, 29); g.lineTo(12, 8); g.lineTo(17, 17); g.lineTo(21, 11); g.lineTo(31, 29); g.closePath(); g.fill();
        g.fillStyle = '#0b1020'; g.shadowBlur = 0; g.beginPath(); g.moveTo(12, 8); g.lineTo(15.2, 14); g.lineTo(12.5, 12.5); g.lineTo(10, 14.5); g.lineTo(8.8, 14); g.closePath(); g.fill(); break;
      default: rr(6, 6, 20, 20, 4);
    }
    g.restore();
  };
  G.draw = function (canvas, L) {
    canvas.width = L.width; canvas.height = L.height;
    var g = canvas.getContext('2d');
    L.ops.forEach(function (o) {
      if (o.type === 'rect') {
        withGlow(g, o.glow, function () {
          roundRect(g, o);
          if (o.fill) { g.fillStyle = paintOf(g, o.fill); g.fill(); }
          if (o.stroke) { g.shadowBlur = o.glow ? o.glow.blur : 0; g.strokeStyle = paintOf(g, o.stroke); g.lineWidth = o.lineWidth || 2; g.stroke(); }
        });
      } else if (o.type === 'circle') {
        withGlow(g, o.glow, function () {
          g.beginPath(); g.arc(o.x, o.y, o.r, 0, Math.PI * 2);
          if (o.fill) { g.fillStyle = paintOf(g, o.fill); g.fill(); }
          if (o.stroke) { g.strokeStyle = paintOf(g, o.stroke); g.lineWidth = o.lineWidth || 2; g.stroke(); }
        });
      } else if (o.type === 'poly') {
        g.beginPath(); o.points.forEach(function (p, i) { if (i) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); }); g.closePath();
        g.fillStyle = paintOf(g, o.fill); g.fill();
      } else if (o.type === 'line') {
        g.beginPath(); g.moveTo(o.x0, o.y0); g.lineTo(o.x1, o.y1); g.strokeStyle = o.color; g.lineWidth = o.width || 1; g.stroke();
      } else if (o.type === 'icon') {
        G.ICON(g, o.name, o.x, o.y, o.size, o.color);
      } else if (o.type === 'text') {
        g.save();
        g.font = (o.italic ? 'italic ' : '') + o.font;
        g.fillStyle = paintOf(g, o.color);
        g.textAlign = o.align; g.textBaseline = 'alphabetic';
        if ('letterSpacing' in g) g.letterSpacing = (o.spacing || 0) + 'px';
        if (o.shadow) { g.shadowColor = o.shadow.color; g.shadowBlur = o.shadow.blur; }
        g.fillText(o.text, o.x, o.y);
        g.restore();
      }
    });
    return canvas;
  };
  G.measureWith = function (canvas) {
    var g = canvas.getContext('2d');
    return function (t, font) { g.font = font; return g.measureText(String(t)).width; };
  };

  /* ================================================================ BROWSER
     render(): fonts first, then content → layout → draw → PNG, cached by
     G.cacheKey (snapshot id + the market quote shown + format + template), so
     a page view never redraws a graphic it already has and a new snapshot
     draws a new one by itself. */
  var CACHE = {}, ORDER = [], MAX = 24;
  G.fontsReady = function (timeoutMs) {
    if (typeof document === 'undefined' || !document.fonts || !document.fonts.load) return Promise.resolve(false);
    var want = ['800 40px "Barlow Condensed"', 'italic 800 40px "Barlow Condensed"', '700 40px "Barlow Condensed"', '600 40px "Barlow Condensed"', '500 20px Inter', '600 20px Inter', '700 20px Inter'];
    var all = Promise.all(want.map(function (f) { return document.fonts.load(f).catch(function () { return null; }); })).then(function () { return true; });
    return Promise.race([all, new Promise(function (r) { setTimeout(function () { r(false); }, timeoutMs || 2500); })]);
  };
  G.render = function (spec, market, format, opts) {
    opts = opts || {};
    format = G.FORMATS[format] ? format : 'square';
    var key = G.cacheKey(spec, market, format, opts.kalshi);
    if (CACHE[key] && !opts.fresh) return Promise.resolve(CACHE[key]);
    var ct = G.content(spec, market, opts);
    if (!ct.ok) return Promise.reject(ct);
    return paint(ct, key, format);
  };
  /* another sport's content, already built to G.layout's shape (lib/edgedesk_nhl_graphic.js):
     the same layout, canvas, PNG and cache; key names the snapshot, the quote shown and the format */
  G.renderContent = function (c, key, format, opts) {
    opts = opts || {};
    format = G.FORMATS[format] ? format : 'square';
    key = [G.VERSION, key, format].join('|');
    if (CACHE[key] && !opts.fresh) return Promise.resolve(CACHE[key]);
    if (!c) return Promise.reject({ ok: false, reason: 'no_spec', message: G.REASON_TEXT.no_spec });
    return paint({ ok: true, content: c }, key, format);
  };
  function paint(ct, key, format) {
    return G.fontsReady().then(function () {
      var canvas = document.createElement('canvas');
      canvas.width = G.FORMATS[format].w; canvas.height = G.FORMATS[format].h;
      var L = G.layout(ct.content, format, G.measureWith(canvas));
      G.draw(canvas, L);
      return new Promise(function (resolve) {
        if (canvas.toBlob) canvas.toBlob(function (b) { resolve(b); }, 'image/png');
        else resolve(null);
      }).then(function (blob) {
        var out = { key: key, format: format, canvas: canvas, blob: blob, url: blob && typeof URL !== 'undefined' ? URL.createObjectURL(blob) : canvas.toDataURL('image/png'),
          content: ct.content, alt: G.altText(ct.content), file_name: G.fileName(ct.content, format) };
        CACHE[key] = out; ORDER.push(key);
        while (ORDER.length > MAX) { var k = ORDER.shift(), old = CACHE[k]; delete CACHE[k]; if (old && old.blob && typeof URL !== 'undefined') try { URL.revokeObjectURL(old.url); } catch (_) {} }
        return out;
      });
    });
  }
  G._cache = function () { return { keys: ORDER.slice() }; };
  return G;
});
