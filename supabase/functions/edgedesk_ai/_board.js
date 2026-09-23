// deno-lint-ignore-file
/*__EDBOARD_START__*/
/* ===========================================================================
   EdgeDesk BOARD KERNEL — the whole card, answered as one question.

   ONE FILE, ONE HOST. This exact block is inlined into
     - supabase/functions/edgedesk_ai/index.ts
   by tools/presentation/inline.js; presentation_sync.test.js fails when the
   copy drifts. Edit THIS file, then `node tools/presentation/inline.js`.

   WHAT IT ANSWERS
     "What are the best bets today?", "What's your strongest college football
     bet this week?", "What's the best NFL total?", "Give me another single
     that isn't in my parlay." — questions about a CARD rather than a game.

   WHAT IT DOES, IN ORDER
     1. SCOPE. The question and the conversation resolve to sports, a date
        window in the reader's own time zone (a documented fallback when the
        browser did not send one), markets, and exclusions carried from
        earlier turns. "today", "tonight", "tomorrow", "this weekend" and
        "this week" are calendar windows in that zone, never in UTC.
     2. ELIGIBILITY. Every scheduled game the host retrieved for every sport
        in scope, minus games that have started, games outside the window,
        excluded games and duplicates. What was dropped is listed with why.
     3. CANDIDATES. Two pricing methods, kept apart and both named:
          MARKET_DEVIG — the decision layer's read of a captured book price
            against the sharp-anchored de-vig fair (EDINTEL.decide), any sport.
          MODEL_BLEND — the pricing kernel's fair line from the validated
            blend of projection and market (EDPRICE), football only, whose
            tier decides whether a probability may be called an edge.
        A candidate carries the quote (book, line, odds, capture time and its
        freshness), the fair estimate with its method and validation, the
        edge with its uncertainty, and what would change it.
     4. QUALIFICATION AND RANKING. Explicit rules, printed with the board.
        A quote must be actionable (fresh, pregame). An outlier edge is
        demoted to a data check, never promoted. The ranking score is a
        labelled, UNVALIDATED heuristic: it orders candidates that already
        qualified; it never turns a PASS into a bet.
     5. ANSWER. A short ranked list with expandable detail, coverage per sport
        (what was evaluated, what could not be), and a watchlist with price
        thresholds when nothing qualifies. Never a forced pick.
     6. RECORD. One immutable research_packets row per emitted opportunity,
        with a deterministic id so a retry cannot double-write.
     7. FOLLOW-UPS. Exclusions, "only college football", "another single",
        "why that one", "what about the under", "I can only get +3 now" —
        resolved against the structured state the client carries back.

   THE RULES
     - No number here is invented. Every probability, fair price and edge is
       read from EDINTEL or EDPRICE, which own them. A spread difference is
       never turned into a cover probability.
     - Quote freshness and research freshness are separate fields.
     - A consensus or reference line is a number to compare against, never a
       price to bet into: it can put a game on the watchlist with a threshold,
       it cannot qualify.
     - Nothing here assumes a bankroll, a stake or a risk preference.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDBOARD = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var VERSION = 1;
  var SCHEMA = 'edgedesk_board_v1';
  var STATE_SCHEMA = 'edgedesk_board_state_v1';
  var RECORD_SCHEMA = 'edgedesk_board_record_v1';
  var DEFAULT_TZ = 'America/New_York';
  var DEFAULT_TZ_BASIS = 'the browser sent no time zone, so EdgeDesk used America/New_York, the zone every published board is printed in';

  /* The sports the product can put on a board, with the pricing methods each
     one can actually reach. `season` months are the calendar months (1-12,
     inclusive, wrapping) in which the sport has a card at all; a sport out of
     season is reported as such rather than read for nothing. */
  var SUPPORTED = {
    americanfootball_nfl: { label: 'NFL', methods: ['MARKET_DEVIG', 'MODEL_BLEND'], window: 'this_week', season: [8, 2], family: 'football' },
    americanfootball_ncaaf: { label: 'college football', methods: ['MARKET_DEVIG', 'MODEL_BLEND'], window: 'this_week', season: [8, 1], family: 'football' },
    baseball_mlb: { label: 'MLB', methods: ['MARKET_DEVIG'], window: 'today', season: [3, 11], family: 'other' },
    basketball_nba: { label: 'NBA', methods: ['MARKET_DEVIG'], window: 'today', season: [10, 6], family: 'other' },
    basketball_wnba: { label: 'WNBA', methods: ['MARKET_DEVIG'], window: 'today', season: [5, 10], family: 'other' },
    basketball_ncaab: { label: 'college basketball', methods: ['MARKET_DEVIG'], window: 'today', season: [11, 4], family: 'other' },
    icehockey_nhl: { label: 'NHL', methods: ['MARKET_DEVIG'], window: 'today', season: [10, 6], family: 'other' },
    mma_mixed_martial_arts: { label: 'UFC', methods: ['MARKET_DEVIG'], window: 'this_week', season: [1, 12], family: 'other' },
    tennis_wta: { label: 'WTA tennis', methods: ['MARKET_DEVIG'], window: 'today', season: [1, 11], family: 'other' }
  };
  var SPORT_WORDS = [
    ['americanfootball_nfl', /\bnfl\b|\bpro football\b/i],
    ['americanfootball_ncaaf', /\b(college football|cfb|ncaaf|ncaa football|fbs)\b/i],
    ['baseball_mlb', /\bmlb\b|\bbaseball\b/i],
    ['basketball_nba', /\bnba\b/i],
    ['basketball_wnba', /\bwnba\b/i],
    ['basketball_ncaab', /\b(college basketball|cbb|ncaab|college hoops)\b/i],
    ['icehockey_nhl', /\bnhl\b|\bhockey\b/i],
    ['mma_mixed_martial_arts', /\bufc\b|\bmma\b/i],
    ['tennis_wta', /\btennis\b|\bwta\b/i]
  ];
  /* Capture's own sanity ceilings per market (LEARN_EDGE_MAX): an EV past
     these is a data question before it is a bet. */
  var SANE_EV = { spreads: 0.10, totals: 0.10, h2h: 0.20, _default: 0.10 };
  /* The research kernel's MODEL DISAGREEMENT threshold, reused so a model
     that is seven points off the market is challenged, not promoted. */
  var OUTLIER_GAP_POINTS = 7;
  var BOOKS = [
    ['draftkings', /\b(draft ?kings|dk)\b/i], ['fanduel', /\b(fan ?duel|fd)\b/i], ['betmgm', /\b(bet ?mgm|mgm)\b/i],
    ['caesars', /\bcaesars?\b/i], ['pinnacle', /\b(pinnacle|pinny)\b/i], ['circa', /\bcirca\b/i], ['betrivers', /\bbet ?rivers\b/i],
    ['bet365', /\bbet ?365\b/i], ['espnbet', /\bespn ?bet\b/i], ['fanatics', /\bfanatics\b/i], ['bovada', /\bbovada\b/i], ['pointsbet', /\bpoints ?bet\b/i]
  ];
  var CERTAINTY = /\b(guarantee|guaranteed|can'?t (lose|miss)|lock|locks|lock of the|sure thing|free money|will (win|cover|cash)|mortal lock|no[- ]brainer|easy money)\b/i;
  var UNSUPPORTED_MARKETS = { player_prop: 'player props', team_total: 'team totals', derivative: 'first-half and quarter markets', futures: 'futures' };
  /* a stale executable price outranks a reference line inside the watchlist; neither can qualify */
  var FRESH_WEIGHT = { CURRENT: 1, AGING: 0.85, STALE: 0.1, UNKNOWN: 0.05, LINE_ONLY: 0.05, STARTED: 0 };
  var TIER_WEIGHT = { VALIDATED: 1, LEAN: 0.8, PROBABILITY: 0.6, RESEARCH: 0.4 };
  var STATUS_RANK = { QUALIFIED: 3, WATCH: 2, RESEARCH: 1, DATA_CHECK: 0 };

  /* ------------------------------------------------------------ helpers */
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return Number.isFinite(n) ? n : null; }
  function str(v) { return v == null ? '' : String(v); }
  function r2(v) { var n = num(v); return n == null ? null : Math.round(n * 100) / 100; }
  function r4(v) { var n = num(v); return n == null ? null : Math.round(n * 10000) / 10000; }
  function toMs(v) { if (v == null || v === '') return null; if (typeof v === 'number') return Number.isFinite(v) ? v : null; var t = Date.parse(String(v)); return Number.isFinite(t) ? t : null; }
  function iso(ms) { var t = toMs(ms); return t == null ? null : new Date(t).toISOString(); }
  function I() { return root.EDINTEL || null; }
  function P() { return root.EDPRICE || null; }
  function R() { return root.EDRESEARCH || null; }
  function normName(s) { var Ik = I(); if (Ik && typeof Ik.normName === 'function') return Ik.normName(s); return str(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  function normMarket(m) { var Ik = I(); if (Ik && typeof Ik.normMarket === 'function') return Ik.normMarket(m); var s = str(m).toLowerCase(); return s === 'spread' ? 'spreads' : s === 'total' ? 'totals' : s === 'moneyline' || s === 'ml' ? 'h2h' : s; }
  function fmtAm(v) { var n = num(v); if (n == null) return '—'; return (n > 0 ? '+' : '') + Math.round(n); }
  function fmtLine(v) { var n = num(v); if (n == null) return ''; return (n > 0 ? '+' : '') + n; }
  function pct(p, d) { var n = num(p); if (n == null) return '—'; return (n * 100).toFixed(d == null ? 1 : d) + '%'; }
  function decToAm(dec) { var d = num(dec); if (d == null || d <= 1) return null; return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); }
  function amToDec(am) { var a = num(am); if (a == null || a === 0) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a); }
  function uniq(a) { var seen = {}, out = []; (a || []).forEach(function (x) { var k = String(x); if (!seen[k]) { seen[k] = 1; out.push(x); } }); return out; }
  function fnv1a(s) { var h = 0x811c9dc5; s = str(s); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return ('0000000' + h.toString(16)).slice(-8); }
  function marketWord(m) { var k = normMarket(m); return k === 'spreads' ? 'spread' : k === 'totals' ? 'total' : k === 'h2h' ? 'moneyline' : str(m); }
  function sportLabel(k) { return SUPPORTED[k] ? SUPPORTED[k].label : str(k || 'this sport'); }

  /* ------------------------------------------------------- time zones */
  function validZone(tz) {
    if (!tz || typeof tz !== 'string' || tz.length > 64 || !/^[A-Za-z_]+(\/[A-Za-z0-9_+\-]+){0,3}$/.test(tz)) return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (_) { return false; }
  }
  function resolveZone(tz, fallback) {
    if (validZone(tz)) return { zone: tz, source: 'client', basis: 'the time zone the browser reported' };
    var fb = validZone(fallback) ? fallback : DEFAULT_TZ;
    return { zone: fb, source: 'fallback', basis: fb === DEFAULT_TZ ? DEFAULT_TZ_BASIS : 'the browser sent no usable time zone, so the deployment default ' + fb + ' was used' };
  }
  function localParts(ms, tz) {
    var f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
    var o = {}; f.formatToParts(new Date(ms)).forEach(function (p) { o[p.type] = p.value; });
    return { y: +o.year, m: +o.month, d: +o.day, hour: +o.hour % 24, minute: +o.minute, second: +o.second, weekday: o.weekday };
  }
  function tzOffsetMs(ms, tz) { var p = localParts(ms, tz); var asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute, p.second); return asUtc - Math.floor(ms / 1000) * 1000; }
  /** Local midnight of the local calendar day that `ms` falls in, plus `dayOffset` days. */
  function localMidnight(ms, tz, dayOffset) {
    var p = localParts(ms, tz);
    var approx = Date.UTC(p.y, p.m - 1, p.d + (dayOffset || 0), 0, 0, 0) - tzOffsetMs(ms, tz);
    /* Re-derive the offset at the target instant so a DST switch inside the window lands on the right midnight. */
    return Date.UTC(p.y, p.m - 1, p.d + (dayOffset || 0), 0, 0, 0) - tzOffsetMs(approx, tz);
  }
  function localDate(ms, tz) { var p = localParts(ms, tz); return p.y + '-' + ('0' + p.m).slice(-2) + '-' + ('0' + p.d).slice(-2); }
  function localTime(ms, tz) {
    var t = toMs(ms); if (t == null) return null;
    try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(t)); } catch (_) { return new Date(t).toISOString(); }
  }
  var WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  /* -------------------------------------------------------------- scope */
  function detectSports(q) { var out = []; SPORT_WORDS.forEach(function (w) { if (w[1].test(q)) out.push(w[0]); }); return uniq(out); }
  function detectMarkets(q) {
    var out = [], unsupported = [];
    if (/\b(player|anytime|touchdown scorer|passing yards|rushing yards|receiving yards|points scored|assists|rebounds|strikeouts|home run)\b.*\b(prop|props|yards|scorer|over|under)\b|\bprops?\b/i.test(q)) unsupported.push('player_prop');
    if (/\bteam total\b/i.test(q)) unsupported.push('team_total');
    if (/\b(first|1st|second|2nd) (half|quarter)\b|\b1h\b|\b1q\b/i.test(q)) unsupported.push('derivative');
    if (/\bfutures?\b|\bto win the (super bowl|title|championship|division|conference)\b/i.test(q)) unsupported.push('futures');
    if (/\btotals?\b|\bover\b|\bunder\b|\bo\/u\b/i.test(q)) out.push('totals');
    if (/\bmoneyline\b|\bmoney line\b|\bml\b|\bwin outright\b|\bstraight up\b/i.test(q)) out.push('h2h');
    if (/\bspreads?\b|\bagainst the spread\b|\bats\b|\bpoints?\b|\bside\b|\bsides\b/i.test(q)) out.push('spreads');
    return { markets: uniq(out), unsupported: uniq(unsupported) };
  }
  function inSeason(sportKey, ms, tz) {
    var s = SUPPORTED[sportKey]; if (!s) return false;
    var m = localParts(ms, tz).m, a = s.season[0], b = s.season[1];
    return a <= b ? (m >= a && m <= b) : (m >= a || m <= b);
  }
  /**
   * Resolve what the question is asking for.
   * o.question, o.now, o.timezone (client), o.default_timezone (deployment),
   * o.sport (the host's resolved sport, if any), o.state (carried board state),
   * o.follow_up (from followUp()), o.supported (host override of SUPPORTED keys)
   */
  function resolveScope(o) {
    o = o || {};
    var q = str(o.question), now = toMs(o.now) != null ? toMs(o.now) : Date.now();
    var tz = resolveZone(o.timezone, o.default_timezone);
    var Z = tz.zone;
    var st = o.state && typeof o.state === 'object' ? o.state : null;
    var fu = o.follow_up || null;
    var supported = Array.isArray(o.supported) && o.supported.length ? o.supported.filter(function (k) { return SUPPORTED[k]; }) : Object.keys(SUPPORTED);

    /* sports: this message > follow-up restriction > host-resolved sport > carried state > every supported sport in season */
    var said = detectSports(q), sportSource, sports;
    if (fu && fu.sports && fu.sports.length) { sports = fu.sports; sportSource = 'the league named in this follow-up'; }
    else if (said.length) { sports = said; sportSource = 'the league named in the question'; }
    else if (o.sport && SUPPORTED[o.sport]) { sports = [o.sport]; sportSource = o.sport_source || 'the sport the conversation resolved'; }
    else if (st && Array.isArray(st.sports) && st.sports.length && fu && fu.is_follow_up) { sports = st.sports.slice(); sportSource = 'the sports of the board this conversation is on'; }
    else { sports = supported.filter(function (k) { return inSeason(k, now, Z); }); sportSource = 'every supported sport in season (a broad question names no league)'; }
    sports = sports.filter(function (k) { return supported.indexOf(k) >= 0; });
    var outOfSeason = supported.filter(function (k) { return !inSeason(k, now, Z) && sports.indexOf(k) < 0; });
    var onlyFootball = sports.every(function (k) { return SUPPORTED[k] && SUPPORTED[k].family === 'football'; });

    /* window, in the reader's zone */
    var kind, from, to, label, windowSource = 'the words in the question';
    var todayMidnight = localMidnight(now, Z, 0), tomorrowMidnight = localMidnight(now, Z, 1);
    if (/\btonight\b/i.test(q)) { kind = 'tonight'; from = now; to = localMidnight(now, Z, 1) + 6 * 3600000; label = 'tonight (' + localDate(now, Z) + ', through 6:00 tomorrow morning in ' + Z + ')'; }
    else if (/\btomorrow\b/i.test(q)) { kind = 'tomorrow'; from = tomorrowMidnight; to = localMidnight(now, Z, 2); label = 'tomorrow (' + localDate(tomorrowMidnight, Z) + ' in ' + Z + ')'; }
    else if (/\bthis weekend\b|\bweekend\b/i.test(q)) {
      var wd = WEEKDAY[localParts(now, Z).weekday] || 0; var toFri = (5 - wd + 7) % 7; var friStart = wd >= 5 || wd === 0 ? todayMidnight : localMidnight(now, Z, toFri);
      var monEnd = wd === 0 ? localMidnight(now, Z, 1) + 6 * 3600000 : localMidnight(now, Z, ((8 - wd) % 7) || 7) + 6 * 3600000;
      kind = 'weekend'; from = Math.max(now, friStart); to = monEnd; label = 'this weekend (Friday through Monday morning in ' + Z + ')';
    }
    else if (/\bthis week\b|\bweek\b|\bupcoming\b|\bnext (few|7|seven) days\b/i.test(q)) { kind = 'this_week'; from = now; to = now + 7 * 86400000; label = 'the next 7 days (from now, ' + Z + ')'; }
    else if (/\btoday\b|\bdaily\b/i.test(q)) { kind = 'today'; from = now; to = tomorrowMidnight; label = 'today (' + localDate(now, Z) + ', until midnight in ' + Z + ')'; }
    else if (fu && fu.is_follow_up && st && st.window && toMs(st.window.to) != null && toMs(st.window.to) > now) { kind = st.window.kind || 'carried'; from = now; to = toMs(st.window.to); label = st.window.label || 'the window of the board this conversation is on'; windowSource = 'the window carried from the previous board'; }
    else if (onlyFootball) { kind = 'this_week'; from = now; to = now + 7 * 86400000; label = 'the next 7 days (a football question with no day named)'; windowSource = 'the default for a football question'; }
    else { kind = 'today'; from = now; to = tomorrowMidnight; label = 'today (' + localDate(now, Z) + ' in ' + Z + '; no day was named, so today is assumed — say "this week" for the football card)'; windowSource = 'the default when no day is named'; }

    var mk = detectMarkets(q);
    var exclusions = { game_ids: [], teams: [] };
    if (st && st.exclusions) { exclusions.game_ids = (st.exclusions.game_ids || []).map(String).slice(0, 60); exclusions.teams = (st.exclusions.teams || []).map(String).slice(0, 60); }
    if (fu && fu.exclusions) { exclusions.game_ids = uniq(exclusions.game_ids.concat(fu.exclusions.game_ids || [])); exclusions.teams = uniq(exclusions.teams.concat(fu.exclusions.teams || [])); }
    var books = []; BOOKS.forEach(function (b) { if (b[1].test(q)) books.push(b[0]); });

    return {
      schema: 'edgedesk_board_scope_v1', now: iso(now),
      timezone: tz,
      sports: sports, sport_source: sportSource, out_of_season: outOfSeason,
      window: { kind: kind, from: iso(from), to: iso(to), label: label, source: windowSource, local_date: localDate(now, Z) },
      markets: mk.markets.length ? mk.markets : null, unsupported_markets: mk.unsupported,
      books: books.length ? books : null,
      exclusions: exclusions,
      parlay: /\bparlay\b/i.test(q),
      ask: fu && fu.is_follow_up ? fu.kind : (/\b(best|strongest|top)\b/i.test(q) ? 'best_bets' : 'board'),
      follow_up: fu || null
    };
  }

  /* --------------------------------------------------------- eligibility */
  /* "Pittsburgh" and "Pittsburgh Panthers" are one program: a name that is the other's prefix is the same side */
  function sameTeam(a, b) { a = normName(a); b = normName(b); if (!a || !b) return false; return a === b || a.indexOf(b + ' ') === 0 || b.indexOf(a + ' ') === 0; }
  function sameGame(g1, g2) { return sameTeam(g1.home_team, g2.home_team) && sameTeam(g1.away_team, g2.away_team) && localDate(toMs(g1.kickoff) || 0, 'UTC') === localDate(toMs(g2.kickoff) || 0, 'UTC'); }
  function eligible(o) {
    o = o || {};
    var now = toMs(o.now) != null ? toMs(o.now) : Date.now();
    var from = toMs(o.window && o.window.from), to = toMs(o.window && o.window.to);
    var ex = o.exclusions || { game_ids: [], teams: [] };
    var exIds = {}; (ex.game_ids || []).forEach(function (id) { exIds[String(id)] = 1; });
    var exTeams = (ex.teams || []).map(normName).filter(Boolean);
    var seen = {}, keep = [], dropped = [];
    (o.games || []).forEach(function (g) {
      var k = toMs(g.kickoff);
      var status = str(g.status).toLowerCase();
      if (status === 'final' || status === 'in_progress') return dropped.push({ game_id: g.game_id, sport: g.sport, matchup: g.matchup, why: 'STARTED', detail: 'status ' + status });
      if (k != null && k <= now) return dropped.push({ game_id: g.game_id, sport: g.sport, matchup: g.matchup, why: 'STARTED', detail: 'kickoff ' + iso(k) + ' has passed; pregame research only' });
      if (k == null) return dropped.push({ game_id: g.game_id, sport: g.sport, matchup: g.matchup, why: 'NO_KICKOFF', detail: 'no start time on file, so it cannot be placed in the window' });
      if (from != null && k < from) return dropped.push({ game_id: g.game_id, sport: g.sport, matchup: g.matchup, why: 'BEFORE_WINDOW', detail: iso(k) });
      if (to != null && k >= to) return dropped.push({ game_id: g.game_id, sport: g.sport, matchup: g.matchup, why: 'AFTER_WINDOW', detail: iso(k) });
      if (exIds[String(g.game_id)]) return dropped.push({ game_id: g.game_id, sport: g.sport, matchup: g.matchup, why: 'EXCLUDED', detail: 'excluded earlier in this conversation' });
      var h = normName(g.home_team), a = normName(g.away_team);
      var exTeam = exTeams.filter(function (t) { return t && (h === t || a === t || h.indexOf(t) >= 0 || a.indexOf(t) >= 0); })[0];
      if (exTeam) return dropped.push({ game_id: g.game_id, sport: g.sport, matchup: g.matchup, why: 'EXCLUDED', detail: 'the reader excluded ' + exTeam });
      var idKey = str(g.sport) + '|' + str(g.game_id);
      if (seen[idKey] || keep.some(function (k) { return k.sport === g.sport && sameGame(k, g); })) return dropped.push({ game_id: g.game_id, sport: g.sport, matchup: g.matchup, why: 'DUPLICATE', detail: 'the same pairing on the same day is already on the board' });
      seen[idKey] = 1;
      keep.push(g);
    });
    keep.sort(function (a, b) { return toMs(a.kickoff) - toMs(b.kickoff); });
    return { games: keep, dropped: dropped, counts: { in: (o.games || []).length, eligible: keep.length, started: dropped.filter(function (d) { return d.why === 'STARTED'; }).length, excluded: dropped.filter(function (d) { return d.why === 'EXCLUDED'; }).length, outside_window: dropped.filter(function (d) { return /WINDOW/.test(d.why); }).length, duplicates: dropped.filter(function (d) { return d.why === 'DUPLICATE'; }).length } };
  }

  /* ---------------------------------------------------------- candidates */
  function sideOf(selection, g) {
    var sel = normName(selection), h = normName(g.home_team), a = normName(g.away_team);
    if (!sel) return null;
    if (sel === h) return 'home'; if (sel === a) return 'away';
    if (/^over\b/.test(sel)) return 'over'; if (/^under\b/.test(sel)) return 'under';
    if (h && (h.indexOf(sel) >= 0 || sel.indexOf(h) >= 0) && !(a && (a.indexOf(sel) >= 0 || sel.indexOf(a) >= 0))) return 'home';
    if (a && (a.indexOf(sel) >= 0 || sel.indexOf(a) >= 0) && !(h && (h.indexOf(sel) >= 0 || sel.indexOf(h) >= 0))) return 'away';
    return null;
  }
  function oppId(sport, gameId, market, side, selection) { return sport + '|' + gameId + '|' + normMarket(market) + '|' + (side || normName(selection)); }

  /** The market-de-vig candidate from one decision-layer row. */
  function fromDecision(d, g, sport, now) {
    var price = d.price || {}, gates = d.gates || {};
    var fresh = gates.freshness || {};
    var market = normMarket(d.market);
    var side = d.side || sideOf(d.selection, g);
    var evPerUnit = num(price.market_ev);
    var edgePp = num(price.probability_edge_pp);
    var sane = SANE_EV[market] != null ? SANE_EV[market] : SANE_EV._default;
    var reasons = [], counter = null, change = [];
    var capAt = d.quote_captured_at || fresh.captured_at || null;
    if (price.fair_label) reasons.push({ text: 'Fair price ' + (price.fair_american != null ? fmtAm(price.fair_american) : pct(price.fair_probability)) + ' (' + price.fair_label + ') against ' + fmtAm(price.offered_american) + ' at ' + (price.book || 'the captured book') + (evPerUnit != null ? ': expected return ' + (evPerUnit >= 0 ? '+' : '') + (evPerUnit * 100).toFixed(1) + '% per unit at that price' : ''), source: 'signals (EdgeDesk capture, ' + (price.fair_method || 'de-vig') + ')', observed_at: capAt, kind: 'PRICE' });
    if (gates.confirmation && gates.confirmation.why) reasons.push({ text: gates.confirmation.why, source: 'signals (book families captured)', observed_at: capAt, kind: 'CONFIRMATION' });
    if (d.disagreement && d.disagreement.level && d.disagreement.level !== 'ORDINARY' && num(d.disagreement.gap) != null) reasons.push({ text: 'EdgeDesk’s projection sits ' + r2(Math.abs(num(d.disagreement.gap))) + ' points from this number (' + d.disagreement.level + ' disagreement); the projection’s validation tier says how far that is evidence', source: 'EdgeDesk projection', observed_at: null, kind: 'MODEL' });
    if (d.blockers && d.blockers.length) counter = d.blockers[0];
    else if (d.evidence_gaps && d.evidence_gaps.length) counter = 'Not examined on this turn: ' + d.evidence_gaps[0].why;
    else if (!(gates.confirmation && gates.confirmation.pass)) counter = 'The price stands on the reference book alone; no independent family confirms it.';
    else counter = 'The case is the price, not the matchup: the de-vig fair assumes the reference book has it right and the margin sits evenly on both sides, which favourite-longshot bias says it does not.';
    (d.what_would_change_it || []).slice(0, 3).forEach(function (t) { change.push(t); });
    return {
      id: oppId(sport, g.game_id, market, side, d.selection), sport: sport, sport_label: sportLabel(sport),
      game_id: String(g.game_id), matchup: g.matchup, home: g.home_team, away: g.away_team, kickoff: g.kickoff,
      market: market, market_word: marketWord(market), side: side, selection: str(d.selection), line: num(d.handicap),
      quote: { book: price.book || null, odds_american: num(price.offered_american != null ? String(price.offered_american).replace('+', '') : decToAm(price.offered_decimal)), odds_decimal: num(price.offered_decimal), captured_at: d.quote_captured_at || fresh.captured_at || null, freshness: fresh.status || 'UNKNOWN', actionable: !!fresh.pass, age_min: null, source: 'signals (EdgeDesk capture)', executable: num(price.offered_decimal) != null },
      fair: { method: 'MARKET_DEVIG', label: price.fair_label || price.fair_method || null, probability: num(price.fair_probability), american: price.fair_american != null ? num(String(price.fair_american).replace('+', '')) : null, push_probability: num(price.push_probability), push_note: price.push_note || null, validation: { tier: gates.model_validation ? gates.model_validation.tier : null, note: 'the fair is a de-vigged market reference, not a model; its record is the CLV ledger' } },
      edge: { ev_per_unit: evPerUnit, probability_edge_pp: edgePp != null ? r2(edgePp * 100) : null, break_even: num(price.break_even_probability), uncertainty: 'The de-vig fair carries no confidence interval. Its error is largest on heavy favourites and long shots; the CLV ledger, not this number, is the evidence that the method works.' },
      decision: { decision: d.decision, strength: d.strength || null, why: d.why, gates: { evidence: !!(gates.evidence && gates.evidence.pass), game_status: !!(gates.game_status && gates.game_status.pass), freshness: !!fresh.pass, price: !!(gates.price && gates.price.pass), provenance: !!(gates.provenance && gates.provenance.pass), confirmation: !!(gates.confirmation && gates.confirmation.pass), model_validation: !!(gates.model_validation && gates.model_validation.pass) } },
      threshold: price.price_limit_american != null ? { kind: 'price', price_limit_american: num(String(price.price_limit_american).replace('+', '')), line: num(d.handicap), method: 'the worst price at which the de-vig fair still clears EdgeDesk’s expected-value floor, at this line only', note: 'A different line cannot be evaluated by this method; it needs a captured quote at that line.' } : { kind: null, method: null, note: 'No price threshold can be calculated: no fair probability is on file for this selection.' },
      reasons: reasons, counter: counter, would_change: change,
      outlier: evPerUnit != null && Math.abs(evPerUnit) > sane ? 'expected value ' + (evPerUnit * 100).toFixed(1) + '% exceeds the ' + (sane * 100) + '% sanity ceiling for a ' + marketWord(market) + '; check the line, the side and the capture before trusting it' : null,
      evidence_packet_id: d.evidence_packet_id || null,
      sig_key: d.sig_key || null
    };
  }

  /** The model-blend candidate from one ranked-slate row of the pricing kernel. */
  function fromPricingRow(r, g, sport, modelMeta, now) {
    var isTotal = r.market === 'total' || r.market === 'totals';
    var market = isTotal ? 'totals' : 'spreads';
    var side = r.side, selection = isTotal ? (side === 'over' ? 'Over' : 'Under') : (r.selection || (side === 'home' ? g.home_team : g.away_team));
    var marketLine = isTotal ? num(r.market_total) : num(r.market_line);
    var fairLine = isTotal ? num(r.fair_total) : num(r.fair_line);
    var modelLine = isTotal ? num(r.model_total) : num(r.model_line);
    var betTo = isTotal ? num(r.bet_to_total) : num(r.bet_to_line);
    var fmtL = isTotal ? function (v) { return v == null ? '' : String(v); } : fmtLine;
    var executable = r.executable === true;
    var gapOut = num(r.gap_points) != null && Math.abs(num(r.gap_points)) >= OUTLIER_GAP_POINTS;
    var reasons = [], change = [];
    if (fairLine != null) reasons.push({ text: 'EdgeDesk’s fair ' + (isTotal ? 'total' : 'line') + ' for ' + selection + ' is ' + fmtL(fairLine) + ' against a market ' + fmtL(marketLine) + (num(r.gap_points) != null ? ' (projection ' + fmtL(modelLine) + ', ' + r.gap_points + ' points from the market)' : '') + '; the fair ' + (isTotal ? 'total' : 'line') + ' gives ' + pct(r.cover_at_market) + ' to cover against ' + pct(r.break_even) + ' required at ' + fmtAm(r.odds_american) + (r.odds_assumed ? ' (price assumed)' : ''), source: 'EdgeDesk pricing kernel (' + (modelMeta && modelMeta.version ? modelMeta.version : 'projection') + ' blended with the market under football/validation/pricing)', observed_at: modelMeta ? modelMeta.generated_at : null, kind: 'MODEL' });
    if (r.tier) reasons.push({ text: 'Validation tier ' + r.tier + (r.tier_basis ? ': ' + r.tier_basis : '') , source: 'football/validation/pricing_' + (sport === 'americanfootball_nfl' ? 'nfl' : 'cfb') + '.json', observed_at: r.validation_generated_at || null, kind: 'VALIDATION' });
    if (betTo != null && (r.tier === 'VALIDATED' || r.tier === 'LEAN')) change.push('The number moving past ' + fmtL(betTo) + ' (the ' + (isTotal ? 'total' : 'line') + ' where the fair cover probability meets the price’s break-even).');
    change.push('A starter change on either side: the projection reads the schedule feed’s starter, not a confirmation.');
    var counter = r.status === 'CONDITIONAL' ? 'RESEARCH tier: the arithmetic is conditional on an unvalidated projection and is not a betting probability.'
      : r.status === 'LEAN_PLAY' ? 'LEAN tier means the graded record cleared break-even at this disagreement, not a profit: this side is on the right side of the number, which is not the same as an edge.'
      : r.status === 'PASS' ? r.why
      : 'The market carries most of the weight in the blend by the validation’s own coefficients; the projection is measured incremental information, not a second opinion of equal standing.';
    return {
      id: oppId(sport, g.game_id, market, side, selection), sport: sport, sport_label: sportLabel(sport),
      game_id: String(g.game_id), matchup: g.matchup, home: g.home_team, away: g.away_team, kickoff: g.kickoff,
      market: market, market_word: marketWord(market), side: side, selection: selection, line: marketLine,
      quote: { book: executable ? (r.book || null) : null, odds_american: executable ? num(r.odds_american) : null, odds_decimal: executable ? amToDec(r.odds_american) : null, captured_at: executable ? (r.observed_at || null) : null, freshness: executable ? (r.freshness || 'UNKNOWN') : 'LINE_ONLY', actionable: executable && !!r.actionable, age_min: null, source: executable ? 'signals (EdgeDesk capture)' : (r.market_source || 'a reference line with no book and no capture time'), executable: executable },
      fair: { method: 'MODEL_BLEND', label: 'fair ' + (isTotal ? 'total ' : 'line ') + fmtL(fairLine) + ' (' + (r.fair_status || 'blend') + ')', probability: num(r.cover_at_market), fair_line: fairLine, model_line: modelLine, sigma: num(r.sigma), is_total: isTotal, validation: { tier: r.tier || 'RESEARCH', basis: r.tier_basis || null, required_edge_points: num(r.required_edge_points), model_version: modelMeta ? modelMeta.version : null, model_generated_at: modelMeta ? modelMeta.generated_at : null, model_freshness: modelMeta ? modelMeta.freshness : null } },
      edge: { ev_per_unit: null, probability_edge_pp: num(r.edge_pp), break_even: num(r.break_even), uncertainty: num(r.sigma) != null ? 'Residual sigma ' + r.sigma + ' points on the margin; the cover probability is a normal on that residual and is a betting probability only under a VALIDATED or LEAN tier (this market: ' + (r.tier || 'RESEARCH') + ').' : 'No residual distribution on file.' },
      decision: { decision: r.status, strength: null, why: r.why, gates: { evidence: true, game_status: true, freshness: executable && !!r.actionable, price: r.status === 'PLAY' || r.status === 'LEAN_PLAY', provenance: true, confirmation: null, model_validation: r.tier === 'VALIDATED' || r.tier === 'LEAN' } },
      threshold: betTo != null && (r.tier === 'VALIDATED' || r.tier === 'LEAN') ? { kind: 'line', bet_to_line: betTo, price_at_market_line: num(r.price_at_market_line), method: 'the ' + (isTotal ? 'total' : 'selection line') + ' where the blended fair cover probability meets the quoted price’s break-even, from the validated residual sigma', note: r.tier === 'LEAN' ? 'LEAN tier: the threshold is where the side stops being on the right side of the number, not where a profit starts.' : null } : { kind: null, method: null, note: 'No bet-to ' + (isTotal ? 'total' : 'line') + ' is quoted: the ' + (r.tier || 'RESEARCH') + ' tier does not support one for this market.' },
      reasons: reasons, counter: counter, would_change: change,
      outlier: gapOut ? 'the projection disagrees with the market by ' + Math.abs(num(r.gap_points)) + ' points, at or past the ' + OUTLIER_GAP_POINTS + '-point disagreement threshold; check identifiers, line direction and the starter before reading it as an edge' : null,
      completeness: num(r.completeness),
      evidence_packet_id: null, sig_key: r.sig_key || null
    };
  }

  /* --------------------------------------------------------- qualification */
  /**
   * The rules, in order, printed with every board. A candidate is QUALIFIED
   * only when a rule says so; the default is RESEARCH.
   */
  var RULES = [
    { id: 'R0_OUTLIER', text: 'An edge past the sanity ceiling, or a projection 7+ points from the market, is a DATA CHECK: it is never promoted until identifiers, line direction and inputs have been checked.' },
    { id: 'R1_PREGAME', text: 'Only a game that has not started, inside the requested window, is considered.' },
    { id: 'R2_FRESH', text: 'A quote qualifies only while its capture is inside the kickoff-based freshness limit (CURRENT or AGING). A STALE, UNKNOWN or reference-only price cannot qualify.' },
    { id: 'R3_MARKET', text: 'MARKET_DEVIG: the decision layer’s BET CANDIDATE (live price, provenance, confirmation and the expected-value floor all passed) qualifies. A WATCH goes to the watchlist with its price limit.' },
    { id: 'R4_MODEL', text: 'MODEL_BLEND: PLAY (VALIDATED tier) qualifies; LEAN_PLAY (LEAN tier: break-even history, not a profit) qualifies only with an executable quote and is labelled LEAN. CONDITIONAL and PROBABILITY never qualify; a LEAN side on a reference line only goes to the watchlist with its bet-to line.' },
    { id: 'R5_MARKETS', text: 'A requested market restricts the board; an unsupported market (player props, team totals, derivatives, futures) is declared unsupported rather than approximated.' },
    { id: 'R6_ORDER', text: 'Ranking score = edge (probability points) × quote-freshness weight × validation-tier weight × input completeness. This ordering is an UNVALIDATED heuristic: it orders what already qualified and cannot promote anything.' },
    { id: 'R7_ONE_PER_GAME', text: 'At most one qualified opportunity per game is emitted (the higher-ranked); the other is kept as a research candidate.' }
  ];
  function qualify(c, scope) {
    var rules = [];
    var wantMarkets = scope && scope.markets ? scope.markets : null;
    if (wantMarkets && wantMarkets.indexOf(c.market) < 0) { rules.push('R5_MARKETS: not the market asked for'); return { status: 'RESEARCH', rules: rules }; }
    if (c.outlier) { rules.push('R0_OUTLIER: ' + c.outlier); return { status: 'DATA_CHECK', rules: rules }; }
    var fresh = c.quote.freshness;
    var freshOk = c.quote.executable && c.quote.actionable && (fresh === 'CURRENT' || fresh === 'AGING');
    if (c.fair.method === 'MARKET_DEVIG') {
      if (c.decision.decision === 'BET CANDIDATE' && freshOk) { rules.push('R3_MARKET: BET CANDIDATE with a live price'); return { status: 'QUALIFIED', rules: rules }; }
      if (c.decision.decision === 'BET CANDIDATE' && !freshOk) { rules.push('R2_FRESH: the price that qualified is ' + fresh + '; re-check before acting'); return { status: 'WATCH', rules: rules }; }
      if (c.decision.decision === 'WATCH') { rules.push('R3_MARKET: WATCH — ' + (c.decision.why || 'the decision layer withheld a recommendation')); return { status: 'WATCH', rules: rules }; }
      /* a price that cleared every gate but freshness is a watch with a re-check, not a research afterthought */
      var g = c.decision.gates || {};
      if (!g.freshness && g.price && g.provenance && g.evidence && g.game_status) { rules.push('R2_FRESH: the last captured price cleared the value and provenance gates but is ' + fresh + '; re-check the board before acting'); return { status: 'WATCH', rules: rules }; }
      rules.push('R3_MARKET: ' + c.decision.decision + ' — ' + (c.decision.why || '')); return { status: 'RESEARCH', rules: rules };
    }
    if (c.fair.method === 'MODEL_BLEND') {
      var s = c.decision.decision;
      if (s === 'PLAY' && freshOk) { rules.push('R4_MODEL: PLAY under a VALIDATED tier with a live quote'); return { status: 'QUALIFIED', rules: rules }; }
      if (s === 'LEAN_PLAY' && freshOk) { rules.push('R4_MODEL: LEAN_PLAY with a live quote — LEAN tier, break-even history, not a profit'); return { status: 'QUALIFIED', rules: rules, lean: true }; }
      if ((s === 'PLAY' || s === 'LEAN_PLAY') && !freshOk) { rules.push('R4_MODEL: ' + s + ' on ' + (c.quote.executable ? 'a ' + fresh + ' quote' : 'a reference line with no executable price') + '; watchlist with the bet-to line'); return { status: 'WATCH', rules: rules }; }
      rules.push('R4_MODEL: ' + s + ' — ' + (c.decision.why || '')); return { status: 'RESEARCH', rules: rules };
    }
    return { status: 'RESEARCH', rules: ['no pricing method'] };
  }
  function rankScore(c) {
    var edge = c.fair.method === 'MARKET_DEVIG' ? (c.edge.probability_edge_pp != null ? c.edge.probability_edge_pp : (c.edge.ev_per_unit != null ? c.edge.ev_per_unit * 100 : null)) : c.edge.probability_edge_pp;
    if (edge == null) return { score: null, basis: 'no edge to score' };
    var fw = FRESH_WEIGHT[c.quote.freshness] != null ? FRESH_WEIGHT[c.quote.freshness] : 0;
    var tier = c.fair.validation && c.fair.validation.tier;
    var tw = c.fair.method === 'MARKET_DEVIG' ? 0.8 : (TIER_WEIGHT[tier] != null ? TIER_WEIGHT[tier] : 0.4);
    var cw = num(c.completeness) != null ? Math.max(0.2, Math.min(1, num(c.completeness))) : 0.7;
    var score = edge * fw * tw * cw;
    return { score: r2(score), basis: 'edge ' + r2(edge) + 'pp × freshness ' + fw + ' × tier ' + tw + (c.fair.method === 'MARKET_DEVIG' ? ' (market de-vig, fixed)' : ' (' + tier + ')') + ' × completeness ' + r2(cw), heuristic: 'UNVALIDATED' };
  }

  /* ---------------------------------------------------------------- build */
  /**
   * o.now, o.scope (resolveScope), o.question
   * o.sports: [{ sport, games:[SlateGame], state:{state,sentence,...}, source_label, errors:[], decisions:[GameDecision], pricing_rows:[EDPRICE.rankSlate rows + executable/actionable/book/observed_at/freshness], model_meta:{version, generated_at, freshness}, refresh:{...} }]
   * o.sports_not_read: [{ sport, why }]   sports in scope the host could not read
   */
  function build(o) {
    o = o || {};
    var now = toMs(o.now) != null ? toMs(o.now) : Date.now();
    var scope = o.scope || resolveScope({ question: o.question, now: now });
    var Z = scope.timezone.zone;
    var coverage = [], allGames = [], byGame = {};
    (o.sports || []).forEach(function (s) {
      var st = s.state || {};
      var games = (s.games || []).map(function (g) { var c = Object.assign({}, g); c.sport = s.sport; return c; });
      var status = st.state === 'RETRIEVAL_FAILED' ? 'RETRIEVAL_FAILED' : !games.length ? 'NO_GAMES' : 'EVALUATED';
      coverage.push({ sport: s.sport, label: sportLabel(s.sport), status: status, scheduled: games.length, source: s.source_label || null, errors: (s.errors || []).slice(0, 3), sentence: st.sentence || null, methods: SUPPORTED[s.sport] ? SUPPORTED[s.sport].methods : ['MARKET_DEVIG'], refresh: s.refresh || null, model: s.model_meta || null });
      games.forEach(function (g) { allGames.push(g); byGame[s.sport + '|' + g.game_id] = g; });
    });
    (o.sports_not_read || []).forEach(function (n) { coverage.push({ sport: n.sport, label: sportLabel(n.sport), status: n.status || 'NOT_EVALUATED', scheduled: null, source: null, errors: [n.why], sentence: n.why, methods: SUPPORTED[n.sport] ? SUPPORTED[n.sport].methods : [], refresh: null, model: null }); });
    (scope.out_of_season || []).forEach(function (k) { if (!coverage.some(function (c) { return c.sport === k; })) coverage.push({ sport: k, label: sportLabel(k), status: 'OUT_OF_SEASON', scheduled: null, source: null, errors: [], sentence: sportLabel(k) + ' is out of season in ' + scope.window.local_date.slice(0, 7) + ' and was not read.', methods: SUPPORTED[k].methods, refresh: null, model: null }); });

    var el = eligible({ games: allGames, now: now, window: scope.window, exclusions: scope.exclusions });
    var elig = {}; el.games.forEach(function (g) { elig[g.sport + '|' + g.game_id] = g; });
    coverage.forEach(function (c) { c.eligible = el.games.filter(function (g) { return g.sport === c.sport; }).length; if (c.status === 'EVALUATED' && !c.eligible) c.status = 'NO_ELIGIBLE_GAMES'; });

    /* candidates from both methods, merged per (game, market, side) */
    var cands = {}, order = [];
    function put(c) { var k = c.id; if (!cands[k]) { cands[k] = c; order.push(k); return; } var prev = cands[k]; /* keep both methods: the model case rides on the market case and vice versa */ if (prev.fair.method !== c.fair.method) { prev.also = c; if (c.fair.method === 'MODEL_BLEND') { prev.model_case = summariseModel(c); } else { c.model_case = summariseModel(prev); c.also = prev; cands[k] = c; } } }
    (o.sports || []).forEach(function (s) {
      (s.decisions || []).forEach(function (d) { var g = elig[s.sport + '|' + d.game_id]; if (!g) return; if (d.decision === 'INSUFFICIENT DATA' && !(d.price && d.price.offered_decimal != null)) return; put(fromDecision(d, g, s.sport, now)); });
      (s.pricing_rows || []).forEach(function (r) { var g = elig[s.sport + '|' + r.game_id]; if (!g || !r.side) return; put(fromPricingRow(r, g, s.sport, s.model_meta || null, now)); });
    });
    var list = order.map(function (k) { return cands[k]; });
    list.forEach(function (c) {
      c.kickoff_local = localTime(c.kickoff, Z);
      c.quote.age_min = c.quote.captured_at ? Math.round((now - toMs(c.quote.captured_at)) / 60000) : null;
      var q = qualify(c, scope); c.qualification = { status: q.status, rules: q.rules, lean: !!q.lean };
      var rs = rankScore(c); c.rank_score = rs.score; c.rank_basis = rs.basis;
      if (c.also) { var q2 = qualify(c.also, scope); if (STATUS_RANK[q2.status] > STATUS_RANK[c.qualification.status]) { /* the stronger method leads, the other is kept as context */ var swap = c.also; swap.also = Object.assign({}, c, { also: undefined }); swap.model_case = c.model_case; swap.qualification = { status: q2.status, rules: q2.rules, lean: !!q2.lean }; var rs2 = rankScore(swap); swap.rank_score = rs2.score; swap.rank_basis = rs2.basis; swap.kickoff_local = c.kickoff_local; swap.quote.age_min = swap.quote.captured_at ? Math.round((now - toMs(swap.quote.captured_at)) / 60000) : null; cands[c.id] = swap; } else { c.also_qualification = q2.status; } }
    });
    list = order.map(function (k) { return cands[k]; });
    list.sort(function (a, b) { return (STATUS_RANK[b.qualification.status] - STATUS_RANK[a.qualification.status]) || ((b.rank_score == null ? -99 : b.rank_score) - (a.rank_score == null ? -99 : a.rank_score)) || (toMs(a.kickoff) - toMs(b.kickoff)); });
    /* one emitted opportunity per game */
    var perGame = {}, qualified = [], watch = [], research = [], checks = [];
    list.forEach(function (c) {
      var gk = c.sport + '|' + c.game_id;
      if (c.qualification.status === 'QUALIFIED') { if (perGame[gk]) { c.qualification.rules.push('R7_ONE_PER_GAME: a higher-ranked selection on this game was emitted'); research.push(c); return; } perGame[gk] = 1; qualified.push(c); return; }
      if (c.qualification.status === 'WATCH') { if (perGame[gk]) { research.push(c); return; } perGame[gk] = 1; watch.push(c); return; }
      if (c.qualification.status === 'DATA_CHECK') { checks.push(c); return; }
      research.push(c);
    });
    var top = num(o.top) || 5;
    /* research leads: when nothing qualifies and nothing watches, the closest
       model-side reads for the market asked for, labelled research only */
    var leads = [];
    if (!qualified.length && !watch.length) {
      leads = research.filter(function (c) {
        if (c.fair.method !== 'MODEL_BLEND' || (scope.markets && scope.markets.indexOf(c.market) < 0) || num(c.fair.model_line) == null || num(c.line) == null) return false;
        /* only the side the projection favours: fewer points needed on a spread, the direction of the total */
        return c.market === 'totals' ? (c.side === 'over' ? num(c.fair.model_line) > num(c.line) : num(c.fair.model_line) < num(c.line)) : num(c.fair.model_line) < num(c.line);
      })
        .sort(function (a, b) { return Math.abs(num(b.fair.model_line) - num(b.line)) - Math.abs(num(a.fair.model_line) - num(a.line)); }).slice(0, 3)
        .map(function (c) { return { id: c.id, sport: c.sport, sport_label: c.sport_label, game_id: c.game_id, matchup: c.matchup, kickoff_local: c.kickoff_local, market: c.market, selection: c.selection, line: c.line, model_line: c.fair.model_line, fair_line: c.fair.fair_line, gap_points: r2(Math.abs(num(c.fair.model_line) - num(c.line))), tier: c.fair.validation && c.fair.validation.tier, status: c.decision.decision, why: c.decision.why, note: 'research only: the ' + (c.fair.validation && c.fair.validation.tier) + ' tier does not support a betting probability for this market' }; });
    }
    var emitted = qualified.slice(0, top);
    emitted.forEach(function (c, i) { c.rank = i + 1; });
    var watchlist = watch.slice(0, Math.max(3, top));
    var focus = null;
    if (scope.follow_up && scope.follow_up.target) {
      var t = scope.follow_up.target;
      focus = list.filter(function (c) { return (t.id && c.id === t.id) || (t.game_id && String(c.game_id) === String(t.game_id) && (!t.market || c.market === normMarket(t.market))); })[0] || null;
      if (focus && scope.follow_up.kind === 'other_side') focus = otherSide(focus, list) || focus;
    }
    var repriced = null;
    if (scope.follow_up && scope.follow_up.kind === 'price_changed' && (focus || emitted[0])) repriced = reprice(focus || emitted[0], scope.follow_up.line_override, now);

    var evaluated = coverage.filter(function (c) { return c.status === 'EVALUATED'; });
    var notEvaluated = coverage.filter(function (c) { return c.status !== 'EVALUATED'; });
    var headline;
    if (emitted.length) headline = emitted.length + ' qualified ' + (emitted.length === 1 ? 'opportunity' : 'opportunities') + ' across ' + evaluated.length + ' sport' + (evaluated.length === 1 ? '' : 's') + ' evaluated for ' + scope.window.label + '.';
    else if (el.games.length) headline = 'Nothing qualifies for ' + scope.window.label + ' under the rules below: ' + el.games.length + ' eligible game' + (el.games.length === 1 ? '' : 's') + ' across ' + evaluated.length + ' sport' + (evaluated.length === 1 ? '' : 's') + ' were evaluated' + (watchlist.length ? '; ' + watchlist.length + ' on the watchlist with a price threshold.' : '.');
    else headline = 'No eligible games for ' + scope.window.label + ': ' + coverage.map(function (c) { return c.label + ' ' + c.status.toLowerCase().replace(/_/g, ' '); }).join(', ') + '.';

    var quotesAt = list.map(function (c) { return toMs(c.quote.captured_at); }).filter(function (t) { return t != null; });
    var packetsAt = coverage.map(function (c) { return c.model ? toMs(c.model.generated_at) : null; }).filter(function (t) { return t != null; });
    var board = {
      schema: SCHEMA, version: VERSION, built_at: iso(now), question: str(o.question).slice(0, 300),
      scope: scope, headline: headline,
      coverage: coverage, eligibility: { counts: el.counts, dropped: el.dropped.slice(0, 40) },
      opportunities: emitted, watchlist: watchlist, data_checks: checks.slice(0, 6), research_leads: leads,
      research_candidates: research.length, candidates_considered: list.length,
      /* the trace, not the answer: every candidate with the rule that placed it */
      candidates: list.slice(0, 60).map(function (c) { return { id: c.id, sport: c.sport, matchup: c.matchup, market: c.market, selection: c.selection, line: c.line, method: c.fair.method, status: c.qualification.status, rule: c.qualification.rules[0] || null, decision: c.decision.decision, freshness: c.quote.freshness, executable: c.quote.executable, edge_pp: c.edge.probability_edge_pp, ev_per_unit: c.edge.ev_per_unit, rank_score: c.rank_score, outlier: c.outlier || null }; }),
      qualified_total: qualified.length,
      /* EVERY candidate, in full, for the layers that size rather than rank.
         The compact `candidates` above is the trace a reader can scan; the
         staking engine needs the whole object — the fair estimate, the quote,
         the threshold and the counter-case — for every market of every game,
         because "evaluate every supported market" is its contract and a
         qualification filter is not a substitute for it. Additive: nothing
         that read this board before sees a different shape. */
      all_candidates: list.slice(0, 200),
      focus: focus, repriced: repriced,
      rules: RULES,
      freshness: {
        quotes: quotesAt.length ? { newest: iso(Math.max.apply(null, quotesAt)), oldest: iso(Math.min.apply(null, quotesAt)), n: quotesAt.length } : { newest: null, oldest: null, n: 0 },
        research: packetsAt.length ? { newest: iso(Math.max.apply(null, packetsAt)), oldest: iso(Math.min.apply(null, packetsAt)), n: packetsAt.length } : { newest: null, oldest: null, n: 0 },
        note: 'Quote freshness (when a book price was captured) and research freshness (when the projection artifacts were built) are separate; a fresh projection does not make an old price current.'
      },
      unsupported: (scope.unsupported_markets || []).map(function (k) { return { market: k, label: UNSUPPORTED_MARKETS[k] || k, note: 'EdgeDesk has no pricing method for ' + (UNSUPPORTED_MARKETS[k] || k) + '; nothing is approximated from another market.' }; }),
      no_bankroll_assumption: 'No stake, bankroll or risk preference is assumed; nothing here is sized.',
      note: 'Research, not picks. Every number is read from EdgeDesk’s own pricing methods and carries its source and observation time. A qualified opportunity is one the rules admit at the quoted price; it is not a promise about the result.'
    };
    board.id = 'board_' + fnv1a(board.built_at + '|' + scope.sports.join(',') + '|' + scope.window.from + '|' + scope.window.to + '|' + emitted.map(function (c) { return c.id; }).join(','));
    return board;
  }
  function summariseModel(c) { return { status: c.decision.decision, tier: c.fair.validation && c.fair.validation.tier, fair_line: c.fair.fair_line, model_line: c.fair.model_line, cover_at_market: c.fair.probability, break_even: c.edge.break_even, edge_pp: c.edge.probability_edge_pp, bet_to_line: c.threshold && c.threshold.bet_to_line != null ? c.threshold.bet_to_line : null, why: c.decision.why, outlier: c.outlier || null }; }
  function otherSide(c, list) {
    var want = c.market === 'totals' ? (c.side === 'over' ? 'under' : 'over') : c.market === 'spreads' || c.market === 'h2h' ? (c.side === 'home' ? 'away' : 'home') : null;
    if (!want) return null;
    return list.filter(function (x) { return x.game_id === c.game_id && x.sport === c.sport && x.market === c.market && x.side === want; })[0] || null;
  }

  /* -------------------------------------------------------------- reprice */
  /** Re-evaluate one opportunity at the reader's own line and/or price. Model-blend: the cover curve moves with the line. Market de-vig: only the price can move; a new line needs a new quote. */
  function reprice(c, over, now) {
    over = over || {};
    var line = num(over.line), odds = num(over.odds);
    if (line == null && odds == null) return { ok: false, why: 'no line or price was given' };
    var Pk = P();
    if (c.fair.method === 'MODEL_BLEND' && Pk && num(c.fair.fair_line) != null && num(c.fair.sigma) != null) {
      var selLine = line != null ? line : c.line, am = odds != null ? odds : (c.quote.odds_american != null ? c.quote.odds_american : -110);
      /* a total is priced through the total-side kernel (over and under mirror around the fair total); a spread through the selection-line curve */
      var at = c.fair.is_total ? totalCoverAt(Pk, c.fair.fair_line, selLine, c.fair.sigma, c.side) : Pk.coverAt(c.fair.fair_line, selLine, c.fair.sigma);
      var be = Pk.breakEven(am, at ? at.push : 0);
      var edge = at && be != null ? r2((at.cover - be) * 100) : null;
      var tier = c.fair.validation.tier;
      var status = tier === 'RESEARCH' ? 'CONDITIONAL' : tier === 'PROBABILITY' ? 'PROBABILITY' : (edge != null && edge >= 0 ? (tier === 'VALIDATED' ? 'PLAY' : 'LEAN_PLAY') : 'PASS');
      var stale = !(c.quote.freshness === 'CURRENT' || c.quote.freshness === 'AGING');
      return { ok: true, method: 'MODEL_BLEND', selection: c.selection, from: { line: c.line, odds_american: c.quote.odds_american, status: c.decision.decision, edge_pp: c.edge.probability_edge_pp }, to: { line: selLine, odds_american: am, cover: at ? at.cover : null, push: at ? at.push : null, break_even: be, edge_pp: edge, status: status }, verdict: status === 'PLAY' || status === 'LEAN_PLAY' ? 'still on the right side of the number at ' + fmtLine(selLine) + ' ' + fmtAm(am) + (status === 'LEAN_PLAY' ? ' (LEAN tier: break-even history, not a profit)' : '') : status === 'PASS' ? 'no longer clears at ' + fmtLine(selLine) + ' ' + fmtAm(am) + ': the fair line gives ' + pct(at && at.cover) + ' against ' + pct(be) + ' required' : 'conditional arithmetic only under the ' + tier + ' tier', freshness_note: stale ? 'The reference quote behind the original read is ' + c.quote.freshness + '; the new line is the reader’s own report and was not verified against a book.' : 'The line is the reader’s own report; EdgeDesk did not verify it against a book.', basis: 'cover probability from the same fair line ' + fmtLine(c.fair.fair_line) + ' and sigma ' + c.fair.sigma };
    }
    var Ik = I();
    if (c.fair.method === 'MARKET_DEVIG' && Ik) {
      if (line != null && line !== c.line) {
        /* the de-vig fair is for one line only; when the model case exists it can move with the line, labelled by its own tier */
        if (c.also && c.also.fair && c.also.fair.method === 'MODEL_BLEND') { var viaModel = reprice(c.also, over, now); if (viaModel && viaModel.ok) { viaModel.note = 'The market de-vig fair applies to ' + fmtLine(c.line) + ' only, so the new line is evaluated through the model case (' + (c.also.fair.validation && c.also.fair.validation.tier) + ' tier), which is ' + (viaModel.to.status === 'CONDITIONAL' ? 'conditional arithmetic, not a betting probability' : 'the validated blend'); return viaModel; } }
        return { ok: false, method: 'MARKET_DEVIG', why: 'the de-vig fair is for ' + c.selection + ' ' + fmtLine(c.line) + ' only; a different line (' + fmtLine(line) + ') needs a captured quote at that number, and none is on file', selection: c.selection };
      }
      var dec = amToDec(odds);
      var e = Ik.ev({ dec: dec, p_win: c.fair.probability, p_push: c.fair.push_probability || 0 });
      var floor = (Ik.config && Ik.config().ev_floor) != null ? Ik.config().ev_floor : 0.005;
      return { ok: true, method: 'MARKET_DEVIG', selection: c.selection, from: { line: c.line, odds_american: c.quote.odds_american, ev_per_unit: c.edge.ev_per_unit }, to: { line: c.line, odds_american: odds, ev_per_unit: e.ev, break_even: Ik.breakEvenProb(dec, c.fair.push_probability || 0) }, verdict: e.ev == null ? 'no expected value could be computed' : e.ev >= floor ? 'still clears the ' + pct(floor, 2) + ' floor at ' + fmtAm(odds) + ' (expected return ' + pct(e.ev, 2) + ' per unit)' : 'does not clear the floor at ' + fmtAm(odds) + ' (expected return ' + pct(e.ev, 2) + ' per unit; the limit is ' + (c.threshold && c.threshold.price_limit_american != null ? fmtAm(c.threshold.price_limit_american) : 'unknown') + ')', freshness_note: 'The fair probability is the captured reference at ' + (c.quote.captured_at || 'an unknown time') + ' (' + c.quote.freshness + '); the new price is the reader’s report.', basis: 'the same de-vig fair probability ' + pct(c.fair.probability) + ' at the reader’s price' };
    }
    return { ok: false, why: 'no pricing method can re-evaluate this selection' };
  }

  function totalCoverAt(Pk, fairTotal, mkt, sigma, side) {
    var r = Pk.priceTotalSide({ fair: { ok: true, fair_total: fairTotal, model_total: null, market_total: mkt, sigma: sigma, tier: 'RESEARCH', required_edge_points: null, gap_points: null, tier_basis: '' }, side: side, odds_american: -110 });
    return r ? { cover: r.cover_at_market, push: r.push_at_market, lose: r.cover_at_market == null ? null : r4(1 - r.cover_at_market - (r.push_at_market || 0)) } : null;
  }

  /* ------------------------------------------------------------ follow-ups */
  function parseLineOdds(q) {
    var out = { line: null, odds: null };
    var m;
    var re = /([+-]\s?\d{1,4}(?:\.5)?)/g;
    while ((m = re.exec(q))) {
      var v = Number(m[1].replace(/\s/g, ''));
      var whole = Math.abs(v);
      if (whole >= 100 && Number.isInteger(whole)) { if (out.odds == null) out.odds = v; }
      else if (whole < 100) { if (out.line == null) out.line = v; }
    }
    if (out.line == null) { var mm = /\b(?:at|get|got|have|has|is|now)\s+(?:the\s+)?(over|under)?\s*(\d{1,3}(?:\.5)?)\b/i.exec(q); if (mm && !/[+-]\s?\d{3}/.test(q)) { var val = Number(mm[2]); if (val < 100) out.line = val; } }
    return out;
  }
  /**
   * Read a follow-up against the carried board state.
   * Returns { is_follow_up, kind, kinds, exclusions:{game_ids, teams}, sports, target:{id, game_id, market}|null, line_override:{line, odds}|null, note }
   */
  function followUp(o) {
    o = o || {};
    var q = str(o.question).trim(), lq = q.toLowerCase();
    var st = o.state && typeof o.state === 'object' && st_ok(o.state) ? o.state : null;
    var out = { is_follow_up: false, kind: null, kinds: [], exclusions: { game_ids: [], teams: [] }, sports: null, target: null, line_override: null, note: null };
    var emitted = st ? (st.emitted || []) : [];
    var last = st && st.last_pick ? st.last_pick : (emitted[0] || null);
    function byOrdinal() { var m = /#\s*([1-9])|\b(first|second|third|1st|2nd|3rd|top)\b|\bnumber\s*([1-9])\b/i.exec(lq); if (!m) return null; var n = m[1] ? +m[1] : m[3] ? +m[3] : { first: 1, '1st': 1, top: 1, second: 2, '2nd': 2, third: 3, '3rd': 3 }[m[2].toLowerCase()]; return emitted[n - 1] || null; }
    function byTeam() { var hits = emitted.filter(function (e) { var h = normName(e.home), a = normName(e.away); return (h && lq.indexOf(h) >= 0) || (a && lq.indexOf(a) >= 0) || (e.selection && lq.indexOf(normName(e.selection)) >= 0); }); return hits[0] || null; }
    var ref = byOrdinal() || byTeam() || ((/\b(that|this|it|the pick|the play|the top one|your pick|that one)\b/.test(lq)) ? last : null);
    var toTarget = function (e) { return e ? { id: e.id, game_id: e.game_id, market: e.market, sport: e.sport } : null; };

    var said = detectSports(q);
    if (/\b(only|just|stick to|limit (it )?to|restrict (it )?to)\b/.test(lq) && said.length) { out.is_follow_up = !!st; out.kinds.push('restrict_sport'); out.sports = said; }
    if (/\b(take|leave|throw|cut|drop|remove|exclude|scratch|kick)\b[^.]{0,30}\b(out|off|away)?\b/.test(lq) && /\b(game|one|that|it|pick|team|out|off)\b/.test(lq) || /\b(no|not|without|skip|except|other than)\b\s+(?:the\s+)?[a-z]/.test(lq) && (byTeam() || /\b(that|this) (game|one|pick)\b/.test(lq))) {
      var tgt = byTeam() || byOrdinal() || ((/\b(that|this|it|the)\b/.test(lq)) ? last : null);
      if (tgt) { out.is_follow_up = !!st; out.kinds.push('exclude_game'); out.exclusions.game_ids.push(String(tgt.game_id)); }
      else { var tm = /\b(?:without|exclude|remove|skip|no|not|drop|take out)\s+(?:the\s+)?([a-z][a-z .&'-]{2,40}?)(?:\s+(?:game|one|pick|out|off)|[,.?!]|$)/.exec(lq); if (tm && !/\bparlay|single|bet|play\b/.test(tm[1])) { out.is_follow_up = !!st; out.kinds.push('exclude_team'); out.exclusions.teams.push(tm[1].trim()); } }
    }
    if (/\b(another|different|next best|one more|what else|something else|other than (that|those|these)|not in my parlay|besides (that|those))\b/.test(lq) && /\b(single|bet|play|pick|one|option|else|game|leg)\b/.test(lq)) {
      out.is_follow_up = !!st; out.kinds.push('another');
      emitted.forEach(function (e) { out.exclusions.game_ids.push(String(e.game_id)); });
      if (st && st.parlay_legs) (st.parlay_legs || []).forEach(function (id) { out.exclusions.game_ids.push(String(id)); });
    }
    if (/\bwhy\b/.test(lq) && (ref || /\b(that|this|it|the pick|the top|#\s*\d|first)\b/.test(lq)) && !/\bwhy not\b/.test(lq)) { out.is_follow_up = !!st; out.kinds.push('why'); out.target = toTarget(ref || last); }
    if (/\bwhat about the (under|over|other side|dog|favou?rite|home|away|road)\b|\bthe other side\b|\bflip it\b|\bthe (under|over) instead\b/.test(lq)) { out.is_follow_up = !!st; out.kinds.push('other_side'); out.target = toTarget(ref || last); }
    var lo = parseLineOdds(q);
    if ((/\b(can only get|only get|i (can|could) get|best i can (get|find)|now (at|it'?s)|it'?s (now|moved to)|moved to|if i (get|take)|at)\b/.test(lq) && (lo.line != null || lo.odds != null)) || (/\bnow\b/.test(lq) && (lo.line != null || lo.odds != null) && ref)) {
      out.is_follow_up = !!st; out.kinds.push('price_changed'); out.target = toTarget(ref || last); out.line_override = lo;
    }
    if (/\b(refresh|re-?check|recheck|still (there|good|available|on)|is that still)\b/.test(lq)) { out.is_follow_up = !!st; out.kinds.push('refresh'); out.target = toTarget(ref || last); }
    if (/\b(what would (make you )?change|change your mind|what would (it take|move you)|what would make you (pass|drop it))\b/.test(lq)) { out.is_follow_up = !!st; out.kinds.push('what_changes'); out.target = toTarget(ref || last); }
    if (/\b(why (does|do) (your|the) model disagree|model (vs|versus|against) (the )?market|disagree with the market)\b/.test(lq)) { out.is_follow_up = !!st; out.kinds.push('model_vs_market'); out.target = toTarget(ref || last); }
    if (/\bagain\b|\bre-?run\b|\bupdate (the )?board\b|\bsame question\b/.test(lq)) { out.is_follow_up = !!st; out.kinds.push('rerun'); }
    out.kind = out.kinds[0] || null;
    out.exclusions.game_ids = uniq(out.exclusions.game_ids); out.exclusions.teams = uniq(out.exclusions.teams);
    if (out.is_follow_up && !st) out.is_follow_up = false;
    if (!st && (out.kinds.length || /\b(that (game|one|pick)|the other side|another (single|bet|play|pick)|different (single|bet|play|pick)|take .{0,30} out|instead)\b/.test(lq))) out.note = 'This reads like a follow-up, but no board is carried in this conversation; it is answered as a fresh question.';
    return out;
  }
  function st_ok(s) { return s && s.schema === STATE_SCHEMA; }

  /** The state the client carries back. Identifiers and the desk's own numbers only. */
  function conversationState(board, prev) {
    var emitted = (board.opportunities || []).map(function (c) { return { id: c.id, rank: c.rank, sport: c.sport, game_id: c.game_id, matchup: c.matchup, home: c.home, away: c.away, kickoff: c.kickoff, market: c.market, side: c.side, selection: c.selection, line: c.line, odds_american: c.quote.odds_american, book: c.quote.book, captured_at: c.quote.captured_at, method: c.fair.method }; });
    var watch = (board.watchlist || []).map(function (c) { return { id: c.id, sport: c.sport, game_id: c.game_id, matchup: c.matchup, home: c.home, away: c.away, market: c.market, side: c.side, selection: c.selection, line: c.line }; });
    var hist = prev && st_ok(prev) && Array.isArray(prev.history) ? prev.history.slice(-20) : [];
    (prev && st_ok(prev) ? (prev.emitted || []) : []).forEach(function (e) { if (!hist.some(function (h) { return h.id === e.id; })) hist.push({ id: e.id, game_id: e.game_id, sport: e.sport, matchup: e.matchup, market: e.market, side: e.side, selection: e.selection, home: e.home, away: e.away }); });
    var focusPick = board.focus ? { id: board.focus.id, game_id: board.focus.game_id, sport: board.focus.sport, matchup: board.focus.matchup, market: board.focus.market, side: board.focus.side, selection: board.focus.selection, home: board.focus.home, away: board.focus.away } : null;
    return {
      schema: STATE_SCHEMA, board_id: board.id, built_at: board.built_at,
      sports: board.scope.sports.slice(), window: { kind: board.scope.window.kind, from: board.scope.window.from, to: board.scope.window.to, label: board.scope.window.label }, timezone: board.scope.timezone.zone,
      exclusions: { game_ids: board.scope.exclusions.game_ids.slice(0, 60), teams: board.scope.exclusions.teams.slice(0, 60) },
      markets: board.scope.markets, parlay_legs: prev && st_ok(prev) && Array.isArray(prev.parlay_legs) ? prev.parlay_legs.slice(0, 20) : [],
      emitted: emitted, watchlist: watch, history: hist.slice(-20),
      last_pick: focusPick || emitted[0] || (prev && st_ok(prev) ? prev.last_pick || null : null),
      turns: Math.min(50, ((prev && st_ok(prev) && num(prev.turns)) || 0) + 1)
    };
  }
  /** Keep identifiers and the desk's own numbers only; drop anything else the browser sent. */
  function sanitizeState(raw) {
    if (!raw || typeof raw !== 'object' || raw.schema !== STATE_SCHEMA) return null;
    function pick(e) { if (!e || typeof e !== 'object') return null; return { id: str(e.id).slice(0, 160), rank: num(e.rank), sport: str(e.sport).slice(0, 40), game_id: str(e.game_id).slice(0, 60), matchup: str(e.matchup).slice(0, 120), home: str(e.home).slice(0, 60), away: str(e.away).slice(0, 60), kickoff: iso(e.kickoff), market: str(e.market).slice(0, 20), side: str(e.side).slice(0, 10) || null, selection: str(e.selection).slice(0, 60), line: num(e.line), odds_american: num(e.odds_american), book: str(e.book).slice(0, 40) || null, captured_at: iso(e.captured_at), method: str(e.method).slice(0, 20) || null }; }
    var sports = Array.isArray(raw.sports) ? raw.sports.filter(function (k) { return SUPPORTED[k]; }).slice(0, 12) : [];
    return {
      schema: STATE_SCHEMA, board_id: str(raw.board_id).slice(0, 40) || null, built_at: iso(raw.built_at),
      sports: sports, window: raw.window && typeof raw.window === 'object' ? { kind: str(raw.window.kind).slice(0, 20), from: iso(raw.window.from), to: iso(raw.window.to), label: str(raw.window.label).slice(0, 160) } : null,
      timezone: validZone(raw.timezone) ? raw.timezone : null,
      exclusions: { game_ids: Array.isArray(raw.exclusions && raw.exclusions.game_ids) ? raw.exclusions.game_ids.map(function (x) { return str(x).slice(0, 60); }).slice(0, 60) : [], teams: Array.isArray(raw.exclusions && raw.exclusions.teams) ? raw.exclusions.teams.map(function (x) { return str(x).slice(0, 60); }).slice(0, 60) : [] },
      markets: Array.isArray(raw.markets) ? raw.markets.map(function (m) { return normMarket(m); }).slice(0, 4) : null,
      parlay_legs: Array.isArray(raw.parlay_legs) ? raw.parlay_legs.map(function (x) { return str(x).slice(0, 60); }).slice(0, 20) : [],
      emitted: Array.isArray(raw.emitted) ? raw.emitted.map(pick).filter(Boolean).slice(0, 12) : [],
      watchlist: Array.isArray(raw.watchlist) ? raw.watchlist.map(pick).filter(Boolean).slice(0, 12) : [],
      history: Array.isArray(raw.history) ? raw.history.map(pick).filter(Boolean).slice(0, 20) : [],
      last_pick: pick(raw.last_pick), turns: Math.min(50, num(raw.turns) || 0)
    };
  }

  /* --------------------------------------------------------------- records */
  /** One immutable research_packets row per emitted opportunity (and per watchlist row, labelled RESEARCH LEAD). Deterministic ids: a retry cannot double-write. */
  function records(board, extra) {
    extra = extra || {};
    var rows = [];
    var built = board.built_at;
    function row(c, kind) {
      var quoteKey = [c.sport, c.game_id, c.market, c.side || c.selection, c.line, c.quote.odds_american, c.quote.book, c.quote.captured_at, c.fair.method, c.fair.validation && c.fair.validation.model_version, str(built).slice(0, 10), kind].join('|');
      var packetId = 'board_' + fnv1a(quoteKey) + fnv1a(quoteKey.split('').reverse().join(''));
      var packet = {
        schema: RECORD_SCHEMA, kind: kind, board_id: board.id, built_at: built, question: board.question,
        request_scope: { sports: board.scope.sports, window: board.scope.window, timezone: board.scope.timezone.zone, markets: board.scope.markets, exclusions: board.scope.exclusions, books: board.scope.books },
        event: { sport: c.sport, game_id: c.game_id, matchup: c.matchup, home: c.home, away: c.away, kickoff: c.kickoff },
        market: { market: c.market, side: c.side, selection: c.selection, line: c.line },
        quote: c.quote, fair: c.fair, edge: c.edge, threshold: c.threshold, model_case: c.model_case || null,
        qualification: c.qualification, rank: c.rank || null, rank_score: c.rank_score, rank_basis: c.rank_basis,
        reasons: c.reasons, counter: c.counter, would_change: c.would_change, outlier: c.outlier || null,
        evidence: { evidence_packet_id: c.evidence_packet_id || null, sig_key: c.sig_key || null, decision: c.decision },
        assumptions: ['no bankroll or stake is assumed', 'the quote is the last capture, not a confirmed live price', c.fair.method === 'MARKET_DEVIG' ? 'the de-vig fair spreads the margin evenly across both sides' : 'the projection’s incremental information is what the validated blend measured'],
        coverage: board.coverage.map(function (x) { return { sport: x.sport, status: x.status, eligible: x.eligible }; }),
        candidates_considered: board.candidates_considered, board_version: VERSION
      };
      return {
        schema: RECORD_SCHEMA, packet_id: packetId, packet_hash: fnv1a(JSON.stringify(packet)), built_at: built,
        sport: c.sport, game_id: c.game_id, matchup: c.matchup, kickoff: c.kickoff, season: null, week: null,
        model_version: c.fair.validation && c.fair.validation.model_version ? c.fair.validation.model_version : (c.fair.method === 'MARKET_DEVIG' ? 'market_devig' : null), kernel_version: VERSION,
        model_home_line: c.fair.model_line != null ? (c.side === 'home' ? c.fair.model_line : (c.fair.model_line != null ? -c.fair.model_line : null)) : null, model_total: null, model_home_win_prob: null,
        model_tier: c.fair.validation ? c.fair.validation.tier || null : null,
        market: c.market, selection: c.selection, side: c.side, handicap: c.line, odds_decimal: c.quote.odds_decimal, book: c.quote.book,
        captured_at: c.quote.captured_at, quote_freshness: c.quote.freshness,
        fair_probability: c.fair.probability, fair_method: c.fair.method + (c.fair.label ? ' (' + c.fair.label + ')' : ''),
        sig_key: c.sig_key || null, gap_points: c.fair.model_line != null && c.line != null ? r2(Math.abs(c.fair.model_line - c.line)) : null,
        ev_per_unit: c.edge.ev_per_unit,
        label: kind === 'RECOMMENDATION' ? 'PRICE DEPENDENT' : 'RESEARCH LEAD', decision: kind === 'RECOMMENDATION' ? (c.qualification.lean ? 'LEAN' : 'QUALIFIED') : 'WATCH',
        data_confidence: null, conclusion_confidence: null, completeness: num(c.completeness),
        question: str(extra.question || board.question).slice(0, 500), packet: packet
      };
    }
    (board.opportunities || []).forEach(function (c) { rows.push(row(c, 'RECOMMENDATION')); });
    (board.watchlist || []).forEach(function (c) { rows.push(row(c, 'WATCH')); });
    /* a forward record precedes the game; eligibility already enforced it, said again here */
    return rows.filter(function (r) { var k = toMs(r.kickoff), b = toMs(r.built_at); return k == null || b == null || b < k; });
  }

  /* ---------------------------------------------------------------- render */
  function oppLines(c, i, o) {
    var L = [];
    var head = (i != null ? (i + 1) + '. ' : '') + c.selection + (c.market === 'totals' ? ' ' + (c.line != null ? c.line : '') : (c.market === 'spreads' && c.line != null ? ' ' + fmtLine(c.line) : c.market === 'h2h' ? ' ML' : '')) + ' — ' + c.matchup + ' (' + c.sport_label + ', ' + (c.kickoff_local || c.kickoff) + ')';
    L.push(head);
    L.push('   ' + (c.quote.executable ? c.quote.book + ' ' + fmtAm(c.quote.odds_american) + ', captured ' + (c.quote.captured_at || 'unknown') + ' (' + c.quote.freshness + (c.quote.age_min != null ? ', ' + c.quote.age_min + ' min ago' : '') + ')' : 'no executable price captured — ' + c.quote.source));
    if (c.fair.method === 'MARKET_DEVIG') L.push('   Fair ' + (c.fair.american != null ? fmtAm(c.fair.american) : pct(c.fair.probability)) + ' (' + (c.fair.label || 'de-vig') + ')' + (c.edge.ev_per_unit != null ? ' · expected return ' + (c.edge.ev_per_unit >= 0 ? '+' : '') + (c.edge.ev_per_unit * 100).toFixed(1) + '% per unit' : '') + (c.edge.probability_edge_pp != null ? ' · ' + (c.edge.probability_edge_pp >= 0 ? '+' : '') + c.edge.probability_edge_pp + ' pp over break-even' : ''));
    else L.push('   Fair line ' + fmtLine(c.fair.fair_line) + ' (' + c.fair.validation.tier + ' tier) · cover ' + pct(c.fair.probability) + ' vs ' + pct(c.edge.break_even) + ' required' + (c.edge.probability_edge_pp != null ? ' (' + (c.edge.probability_edge_pp >= 0 ? '+' : '') + c.edge.probability_edge_pp + ' pp)' : '') + (c.qualification.lean ? ' · LEAN: break-even history, not a profit' : ''));
    if (c.model_case) L.push('   Model case: ' + c.model_case.status + ' (' + c.model_case.tier + ' tier), fair line ' + fmtLine(c.model_case.fair_line) + ', cover ' + pct(c.model_case.cover_at_market) + (c.model_case.outlier ? ' — DATA CHECK: ' + c.model_case.outlier : ''));
    if (!o || !o.compact) {
      c.reasons.slice(0, 3).forEach(function (r) { L.push('   • ' + r.text + ' [' + r.source + (r.observed_at ? ', ' + r.observed_at : '') + ']'); });
      if (c.counter) L.push('   Against: ' + c.counter);
      if (c.would_change.length) L.push('   Would change it: ' + c.would_change.slice(0, 2).join(' '));
      L.push('   Threshold: ' + (c.threshold.kind === 'price' ? 'playable to ' + fmtAm(c.threshold.price_limit_american) + ' at ' + fmtLine(c.threshold.line) + ' (' + c.threshold.method + ')' : c.threshold.kind === 'line' ? 'bet-to ' + fmtLine(c.threshold.bet_to_line) + (c.threshold.price_at_market_line != null ? ', or ' + fmtAm(c.threshold.price_at_market_line) + ' at the market line' : '') + ' (' + c.threshold.method + ')' : c.threshold.note));
      L.push('   Uncertainty: ' + c.edge.uncertainty);
    }
    return L;
  }
  function render(board, o) {
    o = o || {};
    var L = [];
    L.push(board.headline);
    if (board.repriced) L.push('At your number: ' + board.repriced.selection + ' — ' + (board.repriced.ok ? board.repriced.verdict + '. ' + board.repriced.freshness_note : board.repriced.why));
    if (board.focus && board.scope.follow_up && board.scope.follow_up.kind !== 'price_changed') { L.push(''); L.push('About ' + board.focus.selection + ' (' + board.focus.matchup + '):'); L = L.concat(oppLines(board.focus, null, {})); }
    if (board.opportunities.length) { L.push(''); board.opportunities.forEach(function (c, i) { L = L.concat(oppLines(c, i, o)); L.push(''); }); }
    if (board.watchlist.length) { L.push(board.opportunities.length ? 'Watchlist (a threshold, not a bet):' : 'Watchlist — nothing qualifies, these are the closest with the number that would change it:'); board.watchlist.forEach(function (c) { L.push('• ' + c.selection + (c.line != null ? ' ' + (c.market === 'totals' ? c.line : fmtLine(c.line)) : '') + ' — ' + c.matchup + ' (' + c.sport_label + '): ' + (c.qualification.rules[0] || '') + (c.threshold.kind === 'line' ? '; bet-to ' + fmtLine(c.threshold.bet_to_line) : c.threshold.kind === 'price' ? '; playable to ' + fmtAm(c.threshold.price_limit_american) : '; ' + c.threshold.note)); }); L.push(''); }
    if (board.data_checks.length) { L.push('Held back for a data check (not promoted): ' + board.data_checks.map(function (c) { return c.selection + ' (' + c.matchup + '): ' + c.outlier; }).join(' | ')); L.push(''); }
    if (board.research_leads && board.research_leads.length) { L.push('Research leads (not bets; the projection\u2019s tier does not support a betting probability here):'); board.research_leads.forEach(function (c) { L.push('\u2022 ' + c.selection + (c.line != null ? ' ' + (c.market === 'totals' ? c.line : fmtLine(c.line)) : '') + ' \u2014 ' + c.matchup + ' (' + c.sport_label + '): projection ' + (c.market === 'totals' ? c.model_line : fmtLine(c.model_line)) + ' vs market ' + (c.market === 'totals' ? c.line : fmtLine(c.line)) + ', ' + c.gap_points + ' points apart; ' + c.tier + ' tier, ' + c.status); }); L.push(''); }
    L.push('Coverage: ' + board.coverage.map(function (c) { return c.label + ' — ' + (c.status === 'EVALUATED' ? c.eligible + ' eligible game' + (c.eligible === 1 ? '' : 's') + ' evaluated' : c.status.toLowerCase().replace(/_/g, ' ') + (c.errors && c.errors.length ? ' (' + c.errors[0] + ')' : '')); }).join('; ') + '.');
    if (board.unsupported.length) L.push('Not supported: ' + board.unsupported.map(function (u) { return u.label; }).join(', ') + ' — no pricing method exists for them, so nothing is approximated.');
    L.push('Window: ' + board.scope.window.label + '. Time zone: ' + board.scope.timezone.zone + (board.scope.timezone.source === 'fallback' ? ' (' + board.scope.timezone.basis + ')' : '') + '. Quotes captured ' + (board.freshness.quotes.newest ? 'between ' + board.freshness.quotes.oldest + ' and ' + board.freshness.quotes.newest : 'none') + '; research artifacts built ' + (board.freshness.research.newest || 'n/a') + '.');
    L.push(board.note);
    return L.join('\n');
  }

  /* --------------------------------------------------------------- prompt */
  function promptBlock(board) {
    if (!board) return '';
    var L = [];
    L.push('BOARD (' + board.schema + ') — the whole card, evaluated by EdgeDesk’s own pricing methods. This block is the answer; write it, do not extend it. Every number you print must be in it. A game not in it may not be named as an opportunity.');
    L.push('HEADLINE: ' + board.headline);
    L.push('SCOPE: sports ' + board.scope.sports.map(sportLabel).join(', ') + ' (' + board.scope.sport_source + '); window ' + board.scope.window.label + ' (' + board.scope.window.source + '); time zone ' + board.scope.timezone.zone + ' (' + board.scope.timezone.source + ')' + (board.scope.markets ? '; markets ' + board.scope.markets.join(', ') : '') + (board.scope.exclusions.game_ids.length || board.scope.exclusions.teams.length ? '; excluded ' + board.scope.exclusions.game_ids.length + ' game(s) ' + board.scope.exclusions.teams.join(', ') : '') + (board.scope.follow_up && board.scope.follow_up.is_follow_up ? '; follow-up kind ' + board.scope.follow_up.kind : ''));
    L.push('COVERAGE: ' + board.coverage.map(function (c) { return c.label + '=' + c.status + (c.status === 'EVALUATED' ? ' (' + c.eligible + ' eligible of ' + c.scheduled + ' scheduled)' : c.errors && c.errors.length ? ' (' + c.errors[0] + ')' : ''); }).join('; ') + '. Eligibility dropped ' + board.eligibility.counts.started + ' started, ' + board.eligibility.counts.outside_window + ' outside the window, ' + board.eligibility.counts.excluded + ' excluded, ' + board.eligibility.counts.duplicates + ' duplicates.');
    if (board.unsupported.length) L.push('UNSUPPORTED MARKETS ASKED FOR: ' + board.unsupported.map(function (u) { return u.label; }).join(', ') + ' — say so; do not substitute.');
    if (board.repriced) L.push('REPRICED AT THE READER’S NUMBER: ' + JSON.stringify(board.repriced));
    if (board.focus) L.push('FOCUS (the selection the follow-up is about):\n' + oppLines(board.focus, null, {}).join('\n'));
    L.push('QUALIFIED (' + board.opportunities.length + ' of ' + board.candidates_considered + ' candidates; ' + board.watchlist.length + ' on the watchlist; ' + board.data_checks.length + ' held for a data check):');
    board.opportunities.forEach(function (c, i) { L = L.concat(oppLines(c, i, {})); });
    if (board.watchlist.length) { L.push('WATCHLIST (threshold only, never a bet):'); board.watchlist.forEach(function (c) { L = L.concat(oppLines(c, null, { compact: true })); L.push('   Why not qualified: ' + c.qualification.rules.join('; ') + ' · threshold: ' + (c.threshold.kind === 'line' ? 'bet-to ' + fmtLine(c.threshold.bet_to_line) : c.threshold.kind === 'price' ? 'playable to ' + fmtAm(c.threshold.price_limit_american) : c.threshold.note)); }); }
    if (board.data_checks.length) { L.push('DATA CHECKS (never promote):'); board.data_checks.forEach(function (c) { L.push('   ' + c.selection + ' — ' + c.matchup + ': ' + c.outlier); }); }
    if (board.research_leads && board.research_leads.length) { L.push('RESEARCH LEADS (research only, never a bet; say the tier):'); board.research_leads.forEach(function (c) { L.push('   ' + c.selection + ' ' + (c.line == null ? '' : c.market === 'totals' ? c.line : fmtLine(c.line)) + ' — ' + c.matchup + ' (' + c.sport_label + ', ' + c.kickoff_local + '): projection ' + (c.market === 'totals' ? c.model_line : fmtLine(c.model_line)) + ' vs market, ' + c.gap_points + ' pts apart, ' + c.tier + ' tier: ' + c.why); }); }
    L.push('RULES APPLIED: ' + board.rules.map(function (r) { return r.id + ' ' + r.text; }).join(' '));
    L.push('FRESHNESS: ' + board.freshness.note + ' Quotes: ' + (board.freshness.quotes.newest ? board.freshness.quotes.oldest + ' to ' + board.freshness.quotes.newest : 'none') + '. Research artifacts: ' + (board.freshness.research.newest || 'none') + '.');
    L.push('WRITE: lead with the ranked list (or with "nothing qualifies" and the watchlist). For each qualified opportunity: matchup and local start time, market and selection, book / line / odds / capture time, the fair estimate with its method, the edge with its uncertainty, two or three sourced reasons, the strongest counterargument, what would change it, and the threshold or that none can be calculated. Then coverage in one sentence, naming any sport that could not be evaluated. Never state a stake, a bankroll fraction, a profit, a certainty, or a game that is not in this block. Say LEAN where the block says LEAN. Do not multiply probabilities for a parlay. ' + board.no_bankroll_assumption);
    return L.join('\n');
  }
  /** Numbers and names the critic may allow from the board. */
  function allowedFrom(board) {
    var nums = [], names = [];
    function add(v) { var n = num(v); if (n != null) nums.push(n); }
    (board.opportunities || []).concat(board.watchlist || [], board.data_checks || [], board.focus ? [board.focus] : []).forEach(function (c) {
      add(c.line); add(c.quote.odds_american); add(c.quote.odds_decimal); add(c.fair.american); add(c.fair.probability); add(c.fair.fair_line); add(c.fair.model_line); add(c.fair.sigma); add(c.edge.ev_per_unit); add(c.edge.probability_edge_pp); add(c.edge.break_even); add(c.quote.age_min); add(c.rank_score);
      if (c.threshold) { add(c.threshold.price_limit_american); add(c.threshold.bet_to_line); add(c.threshold.price_at_market_line); }
      if (c.model_case) { add(c.model_case.fair_line); add(c.model_case.model_line); add(c.model_case.cover_at_market); add(c.model_case.break_even); add(c.model_case.edge_pp); add(c.model_case.bet_to_line); }
      names.push(c.home, c.away, c.selection, c.quote.book);
    });
    if (board.repriced && board.repriced.ok) { add(board.repriced.to.line); add(board.repriced.to.odds_american); add(board.repriced.to.cover); add(board.repriced.to.break_even); add(board.repriced.to.edge_pp); add(board.repriced.to.ev_per_unit); add(board.repriced.from.line); add(board.repriced.from.odds_american); }
    (board.research_leads || []).forEach(function (c) { add(c.line); add(c.model_line); add(c.fair_line); add(c.gap_points); names.push(c.selection, c.matchup); });
    (board.coverage || []).forEach(function (c) { add(c.eligible); add(c.scheduled); });
    add(board.opportunities.length); add(board.watchlist.length); add(board.candidates_considered);
    return { numbers: nums, names: names.filter(Boolean) };
  }
  /** Board-specific critic checks. Returns [{code, severity, detail}]. */
  function criticExtras(o) {
    o = o || {};
    var a = str(o.answer), board = o.board, issues = [];
    if (!board) return issues;
    var la = a.toLowerCase();
    var known = {}; (o.known_games || []).concat(board.opportunities, board.watchlist, board.data_checks).forEach(function (g) { if (!g) return; [g.home, g.away, g.home_team, g.away_team, g.selection].forEach(function (n) { var k = normName(n); if (k) known[k] = 1; }); });
    /* a bet/play verb on a selection that is not qualified */
    var qualNames = board.opportunities.map(function (c) { return normName(c.selection); });
    var betRe = /\b(bet|play|take|hammer|fire on|back)\b\s+(?:the\s+)?([a-z][a-z .&'-]{2,40}?)(?:\s+[+-]?\d|\s+ml\b|\s+moneyline|\s+over|\s+under|[,.;!?]|$)/g, m;
    while ((m = betRe.exec(la))) { var who = normName(m[2]); if (!who || who.length < 3) continue; var isQual = qualNames.some(function (q) { return q && (q === who || q.indexOf(who) >= 0 || who.indexOf(q) >= 0); }); if (!isQual && (board.watchlist.concat(board.data_checks)).some(function (c) { var s = normName(c.selection); return s && (s === who || s.indexOf(who) >= 0 || who.indexOf(s) >= 0); })) issues.push({ code: 'BOARD_UNQUALIFIED_RECOMMENDED', severity: 'FAIL', detail: 'the answer tells the reader to ' + m[1] + ' "' + m[2].trim() + '", which is on the watchlist or held for a data check, not qualified' }); }
    if (!board.opportunities.length && /\b(best bet is|my (top |best )?pick is|the play (here )?is|i(?:'d| would) (bet|take|play)|lock\b)/i.test(a)) issues.push({ code: 'BOARD_FORCED_PICK', severity: 'FAIL', detail: 'nothing qualified and the answer names a pick anyway' });
    if (/\b(\d+(\.\d+)?\s*%\s*of (your |the )?bankroll|\d+(\.\d+)?\s*units?\b|unit size|stake \d)/i.test(a)) issues.push({ code: 'BOARD_STAKE', severity: 'FAIL', detail: 'the answer sizes a bet; no bankroll or stake was given' });
    var certRe = R() && R().FORBIDDEN_CERTAINTY instanceof RegExp ? R().FORBIDDEN_CERTAINTY : CERTAINTY;
    if (certRe.test(a) || CERTAINTY.test(a)) issues.push({ code: 'BOARD_CERTAINTY', severity: 'FAIL', detail: 'certainty language over a research board' });
    if (/\bparlay\b/i.test(a) && /\b\d{1,2}(\.\d)?\s*%\s*(chance|probability|to hit)\b|\bcombined (probability|odds)\b/i.test(a)) issues.push({ code: 'BOARD_PARLAY_MULTIPLIED', severity: 'FAIL', detail: 'the answer states a combined parlay probability; leg probabilities are not independent and no method supports the product' });
    var leanOnly = board.opportunities.length && board.opportunities.every(function (c) { return c.qualification.lean; });
    if (leanOnly && /\b(edge|profitable|\+ev|value bet)\b/i.test(a) && !/\blean\b/i.test(a)) issues.push({ code: 'BOARD_LEAN_AS_EDGE', severity: 'WARN', detail: 'every qualified opportunity is LEAN and the answer calls it an edge without the word LEAN' });
    /* a matchup named as an opportunity that is not on the board */
    var cap = /\b([A-Z][A-Za-z.&'-]+(?:\s[A-Z][A-Za-z.&'-]+){0,3})\s+(?:[+-]\d{1,2}(?:\.5)?|ML|moneyline|over|under)\b/g, mm;
    while ((mm = cap.exec(a))) { var nm = normName(mm[1]); if (!nm || /^(the|and|at|vs|over|under|fair|market|book|line|odds|edgedesk|lean|play|pass|watch|bet|take)$/.test(nm)) continue; var ok = Object.keys(known).some(function (k) { return k === nm || k.indexOf(nm) >= 0 || nm.indexOf(k) >= 0; }); if (!ok) issues.push({ code: 'BOARD_UNKNOWN_SELECTION', severity: 'FAIL', detail: 'the answer prices "' + mm[0] + '", which is not on the board' }); }
    return issues;
  }

  return {
    VERSION: VERSION, SCHEMA: SCHEMA, STATE_SCHEMA: STATE_SCHEMA, RECORD_SCHEMA: RECORD_SCHEMA, SUPPORTED: SUPPORTED, RULES: RULES, DEFAULT_TZ: DEFAULT_TZ, SANE_EV: SANE_EV, OUTLIER_GAP_POINTS: OUTLIER_GAP_POINTS,
    FRESH_WEIGHT: FRESH_WEIGHT, TIER_WEIGHT: TIER_WEIGHT,
    validZone: validZone, resolveZone: resolveZone, localMidnight: localMidnight, localDate: localDate, localTime: localTime, inSeason: inSeason,
    detectSports: detectSports, detectMarkets: detectMarkets, resolveScope: resolveScope,
    eligible: eligible, sideOf: sideOf, fromDecision: fromDecision, fromPricingRow: fromPricingRow, qualify: qualify, rankScore: rankScore,
    build: build, reprice: reprice, followUp: followUp, parseLineOdds: parseLineOdds,
    conversationState: conversationState, sanitizeState: sanitizeState, records: records,
    render: render, promptBlock: promptBlock, allowedFrom: allowedFrom, criticExtras: criticExtras
  };
});
/*__EDBOARD_END__*/
