/* ===========================================================================
   EdgeDesk — NOVIG MARKET MATCHING: a Novig market to the book's own game,
   market, line and side, or a reason it is left unmapped.

   ONE ANSWER TO "IS THIS THE SAME BET?" Novig's catalog
   (docs.novig.com/api/concepts/universe-model.md) and The Odds API's
   (public.signals, public.sharp_price_snapshots) describe the same games in
   different words. A comparison is only made when every one of these holds;
   any doubt is a rejection with its reason, never a guess:
     sport + league     Novig's league maps to exactly one Odds API sport key
     event              exactly one book event of that sport has BOTH teams,
                        the same home and away (a swapped listing is
                        refused: a spread's strike is the HOME side's
                        handicap), kickoff within the sport's tolerance
     teams              resolved through lib/football_identity.js for NFL and
                        college football (an NFL club by its symbol AND its
                        name, which must agree), and by the exact full name
                        elsewhere. Novig's `description` is never parsed
                        (Novig: "Display text. Don't parse it")
     market type        MONEY/SPREAD/TOTAL (full game) and their _1H twins
                        only; every other type is unsupported, not mapped
     period             full game against full game, first half against first
                        half
     line               the exact strike: a spread of −3.5 is never compared
                        with −4.5, a total of 47.5 never with 48
     orientation        each outcome is read from its own name and checked
                        against the market: a spread's home outcome must
                        carry the strike, the away outcome its negation; a
                        total's Over and Under must both carry the strike;
                        a moneyline's two outcomes must be the two teams
     overtime           MONEY is a two-way market with no draw outcome, the
                        same structure as the book's h2h (which includes
                        overtime); a three-way (regulation) market is a
                        different type and is never mapped to h2h
     settlement         recorded, not assumed equal: Novig voids a market at
                        fair market value (`voids: FMV`) where a sportsbook
                        refunds; Novig does not document how a two-way NFL
                        moneyline settles a tie. Both are carried as
                        settlement notes on every comparison and lower the
                        confidence where they can bite
   CONFIDENCE  high    both teams resolved by full name (and, in the NFL, by
                       symbol too), kickoff within 15 minutes, no settlement
                       note that applies to an ordinary result
               medium  everything verified, but a team needed an alias or a
                       mascot strip, the kickoff differs by more than 15
                       minutes inside the tolerance, or a settlement note can
                       apply to an ordinary result (an NFL moneyline tie)
   Nothing lower is linked.

   Usable in Node (require; needs lib/football_identity.js beside it), the
   browser (window.EDNovigMap, after FootballIdentity) and Deno (inlined into
   supabase/functions/novig_sync by tools/novig/inline.js, drift-tested).
   =========================================================================== */
(function (root, factory) {
  var FI = root && root.FootballIdentity;
  if (!FI && typeof require === 'function') { try { FI = require('./football_identity.js'); } catch (_) { FI = null; } }
  var api = factory(FI);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDNovigMap = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (FI) {
  'use strict';

  var LINKER_VERSION = 'novig-link-1';

  /* Novig league -> the Odds API sport key public.signals uses, and the
     kickoff tolerance. Football moves rarely and plays weekly (36 h, the
     board's own tolerance); the daily sports play the same opponent on
     consecutive days and in doubleheaders, so a wider window would be
     ambiguous: 4 h. */
  var LEAGUES = {
    NFL:     { sport_key: 'americanfootball_nfl',   identity: 'NFL', tolerance_min: 36 * 60, sport: 'nfl' },
    NCAAF:   { sport_key: 'americanfootball_ncaaf', identity: 'CFB', tolerance_min: 36 * 60, sport: 'cfb' },
    NBA:     { sport_key: 'basketball_nba',         identity: null,  tolerance_min: 4 * 60,  sport: 'nba' },
    NHL:     { sport_key: 'icehockey_nhl',          identity: null,  tolerance_min: 4 * 60,  sport: 'nhl' },
    MLB:     { sport_key: 'baseball_mlb',           identity: null,  tolerance_min: 4 * 60,  sport: 'mlb' },
    NCAAB:   { sport_key: 'basketball_ncaab',       identity: null,  tolerance_min: 4 * 60,  sport: 'ncaab' },
    WNBA:    { sport_key: 'basketball_wnba',        identity: null,  tolerance_min: 4 * 60,  sport: 'wnba' },
    NCAABSB: { sport_key: 'baseball_ncaa',          identity: null,  tolerance_min: 4 * 60,  sport: 'cbase' },
    NCAAWB:  { sport_key: 'basketball_wncaab',      identity: null,  tolerance_min: 4 * 60,  sport: 'ncaaw' }
  };
  /* Novig market type -> the Odds API market key, its period and its shape */
  var MARKET_TYPES = {
    MONEY:     { book_market: 'h2h',       period: 'game',       shape: 'teams' },
    SPREAD:    { book_market: 'spreads',   period: 'game',       shape: 'spread' },
    TOTAL:     { book_market: 'totals',    period: 'game',       shape: 'total' },
    MONEY_1H:  { book_market: 'h2h_h1',    period: 'first_half', shape: 'teams' },
    SPREAD_1H: { book_market: 'spreads_h1', period: 'first_half', shape: 'spread' },
    TOTAL_1H:  { book_market: 'totals_h1', period: 'first_half', shape: 'total' }
  };
  var CLOSE_KICKOFF_MIN = 15;

  function key(s) { return FI ? FI.teamKey(s) : String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ''); }
  /** a decimal line as a canonical string: "-3.50" -> "-3.5", "+3" -> "3", "0" -> "0" */
  function line(s) {
    var m = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(String(s == null ? '' : s).trim());
    if (!m) return null;
    var frac = (m[3] || '').replace(/0+$/, ''), whole = m[2].replace(/^0+(?=\d)/, '');
    var v = whole + (frac ? '.' + frac : '');
    return v === '0' ? '0' : (m[1] === '-' ? '-' : '') + v;
  }
  function negate(l) { return l == null ? null : l === '0' ? '0' : l.charAt(0) === '-' ? l.slice(1) : '-' + l; }

  /* ------------------------------------------------------------ teams
     A resolver for one league: given a Novig competitor ({name, shortName,
     symbol}) and a book team name, are they the same team, and how sure? */
  var NFL_REG = null;
  function nflRegistry() {
    if (!NFL_REG && FI) NFL_REG = FI.buildRegistry('NFL', FI.NFL_TEAMS.map(function (t) { return { id: t[0], name: t[1], code: t[0], aliases: t[2] }; }));
    return NFL_REG;
  }
  function nflClub(raw) { var r = FI ? FI.resolveTeam(nflRegistry(), raw, []) : null; return r && r.team_id ? { id: r.team_id, method: r.method } : null; }
  /** the club a Novig NFL competitor is: its symbol and its name must agree when both exist */
  function nflCompetitor(c) {
    var bySym = c.symbol ? nflClub(c.symbol) : null, byName = c.name ? nflClub(c.name) : null;
    if (bySym && byName && bySym.id !== byName.id) return { id: null, reason: 'competitor_symbol_name_conflict' };
    var id = (byName || bySym || {}).id || null;
    if (!id) return { id: null, reason: 'competitor_unresolved' };
    return { id: id, strong: !!(bySym && byName) && byName.method === 'name', method: (bySym ? 'symbol' : '') + (bySym && byName ? '+' : '') + (byName ? 'name:' + byName.method : '') };
  }
  /** Are Novig's home and away the book event's home and away?
      -> {match: 'same' | 'swapped' | 'one' | 'none', strong, method, reason} */
  function pairMatch(league, home, away, b) {
    var L = LEAGUES[league];
    var ids;
    if (L.identity === 'NFL') {
      var nh = nflCompetitor(home), na = nflCompetitor(away);
      if (!nh.id || !na.id) return { match: 'none', reason: nh.reason || na.reason };
      var bh = nflClub(b.home), ba = nflClub(b.away);
      if (!bh || !ba) return { match: 'none', reason: 'book_team_unresolved' };
      ids = { h: bh.id, a: ba.id };
      var strongNfl = nh.strong && na.strong && bh.method === 'name' && ba.method === 'name';
      return classify(nh.id === ids.h, na.id === ids.a, nh.id === ids.a, na.id === ids.h, strongNfl, 'home:' + nh.method + '|away:' + na.method + '|book:' + bh.method + '+' + ba.method);
    }
    if (L.identity === 'CFB' && FI) {
      /* the registry holds Novig's two names; the book's names (with mascots)
         are resolved against it, as kalshi_sync resolves the book against
         Kalshi's: the resolver strips mascots from what it READS */
      var reg = FI.buildRegistry('CFB', [
        { id: 'H', name: home.name || null, aliases: [home.shortName].filter(Boolean) },
        { id: 'A', name: away.name || null, aliases: [away.shortName].filter(Boolean) }]);
      if (!home.name && !home.shortName || !away.name && !away.shortName) return { match: 'none', reason: 'competitor_unnamed' };
      var uni = [b.home, b.away];
      var rh = FI.resolveTeam(reg, b.home, uni), ra = FI.resolveTeam(reg, b.away, uni);
      var strongCfb = rh.method === 'name' && ra.method === 'name';
      return classify(rh.team_id === 'H', ra.team_id === 'A', rh.team_id === 'A', ra.team_id === 'H', strongCfb, 'cfb:book_home=' + (rh.method || rh.reason) + '|book_away=' + (ra.method || ra.reason));
    }
    /* the daily leagues: Novig's full name and the book's full name, exactly */
    if (!home.name || !away.name) return { match: 'none', reason: 'competitor_unnamed' };
    return classify(key(home.name) === key(b.home), key(away.name) === key(b.away), key(home.name) === key(b.away), key(away.name) === key(b.home), true, 'exact_name');
  }
  function classify(hh, aa, ha, ah, strong, method) {
    if (hh && aa) return { match: 'same', strong: strong, method: method };
    if (ha && ah) return { match: 'swapped', method: method };
    if (hh || aa || ha || ah) return { match: 'one', method: method };
    return { match: 'none', method: method };
  }

  /* ------------------------------------------------------------ the event */
  /** participants: {homeCompetitorId, awayCompetitorId, competitors:[{competitorId,name,shortName,symbol,marketIds}]}
      books: [{event_id, sport_key, home, away, kickoff_ms}] */
  function matchEvent(ev, participants, books) {
    var L = LEAGUES[ev && ev.league];
    if (!L) return { reason: 'unsupported_league', detail: { league: ev && ev.league } };
    if (!participants || !participants.homeCompetitorId || !participants.awayCompetitorId) return { reason: 'no_home_away', detail: { event: ev.eventId } };
    var byId = {};
    (participants.competitors || []).forEach(function (c) { byId[c.competitorId] = c; });
    var home = byId[participants.homeCompetitorId], away = byId[participants.awayCompetitorId];
    if (!home || !away) return { reason: 'competitor_missing' };
    if (participants.homeCompetitorId === participants.awayCompetitorId) return { reason: 'same_team_twice' };
    var t = Number(ev.startsTs);
    if (!isFinite(t)) return { reason: 'no_start_time' };
    var cands = [], swapped = [], oneTeam = [], refused = [];
    (books || []).filter(function (b) { return b.sport_key === L.sport_key && isFinite(b.kickoff_ms) && Math.abs(b.kickoff_ms - t) <= L.tolerance_min * 60000; }).forEach(function (b) {
      var pm = pairMatch(ev.league, home, away, b);
      if (pm.match === 'same') cands.push({ b: b, pm: pm });
      else if (pm.match === 'swapped') swapped.push(b.event_id);
      else if (pm.match === 'one') oneTeam.push(b.event_id);
      else if (pm.reason && pm.reason !== 'book_team_unresolved') refused.push(pm.reason);
    });
    if (cands.length > 1) return { reason: 'ambiguous_book_event', detail: { events: cands.map(function (c) { return c.b.event_id; }) } };
    if (!cands.length) {
      if (swapped.length) return { reason: 'home_away_swapped', detail: { events: swapped } };
      if (oneTeam.length) return { reason: 'one_team_only', detail: { events: oneTeam, home: home.name || home.symbol, away: away.name || away.symbol } };
      if (refused.length) return { reason: refused[0], detail: { home: home.name || home.symbol, away: away.name || away.symbol } };
      return { reason: 'no_book_event', detail: { home: home.name || home.symbol, away: away.name || away.symbol, starts: new Date(t).toISOString() } };
    }
    var c = cands[0], dMin = Math.abs(c.b.kickoff_ms - t) / 60000;
    return {
      event: {
        novig_event_id: ev.eventId, league: ev.league, sport: L.sport, odds_event_id: c.b.event_id, odds_sport_key: c.b.sport_key,
        home_team: c.b.home, away_team: c.b.away, kickoff_at: new Date(c.b.kickoff_ms).toISOString(), novig_starts_at: new Date(t).toISOString(),
        kickoff_delta_min: Math.round(dMin * 10) / 10, home: home, away: away,
        strong: !!c.pm.strong && dMin <= CLOSE_KICKOFF_MIN,
        method: c.pm.method + '|kickoff:' + Math.round(dMin) + 'm'
      }
    };
  }

  /* ------------------------------------------------------------ one outcome's own reading */
  /** which competitor an outcome name is (symbol, short name or full name, exactly) */
  function competitorOf(name, ev) {
    var k = key(name), hits = [];
    [['home', ev.home], ['away', ev.away]].forEach(function (p) {
      var c = p[1];
      if ([c.symbol, c.shortName, c.name].filter(Boolean).some(function (x) { return key(x) === k; })) hits.push(p[0]);
    });
    return hits.length === 1 ? hits[0] : null;
  }
  /** "BUF -3.5" -> {team:'BUF', line:'-3.5'}; "Over 47.5" -> {ou:'Over', line:'47.5'} */
  function parseOutcome(name) {
    var s = String(name == null ? '' : name).trim();
    var ou = /^(Over|Under)\s+([+-]?\d+(?:\.\d+)?)$/i.exec(s);
    if (ou) return { ou: ou[1].charAt(0).toUpperCase() + ou[1].slice(1).toLowerCase(), line: line(ou[2]) };
    var sp = /^(.+?)\s+([+-]\d+(?:\.\d+)?|0)$/.exec(s);
    if (sp) return { team: sp[1].trim(), line: line(sp[2]) };
    return { team: s, line: null };
  }

  /** one Novig market -> its link to the book's market, or a reason */
  function mapMarket(m, ev) {
    var T = MARKET_TYPES[m && m.marketType];
    if (!T) return { reason: 'unsupported_market_type', detail: { marketType: m && m.marketType } };
    if (!Array.isArray(m.outcomes) || m.outcomes.length !== 2) return { reason: 'not_two_outcomes', detail: { n: m.outcomes ? m.outcomes.length : 0 } };
    var strike = m.strike == null ? null : line(m.strike);
    var outs = [];
    for (var i = 0; i < 2; i++) {
      var o = m.outcomes[i], p = parseOutcome(o.name);
      if (T.shape === 'total') {
        if (!p.ou) return { reason: 'total_outcome_unreadable', detail: { name: o.name } };
        if (strike == null || p.line !== strike) return { reason: 'total_line_mismatch', detail: { name: o.name, strike: m.strike } };
        outs.push({ outcome_id: o.outcomeId, novig_name: o.name, side: p.ou, point: strike });
        continue;
      }
      var who = competitorOf(p.team, ev);
      if (!who) return { reason: 'outcome_team_unresolved', detail: { name: o.name } };
      if (T.shape === 'teams') {
        if (p.line != null && p.line !== '0') return { reason: 'moneyline_with_a_line', detail: { name: o.name } };
        if (strike != null && strike !== '0') return { reason: 'moneyline_with_a_strike', detail: { strike: m.strike } };
        outs.push({ outcome_id: o.outcomeId, novig_name: o.name, who: who, side: who === 'home' ? ev.home_team : ev.away_team, point: null });
      } else {
        if (strike == null || p.line == null) return { reason: 'spread_line_missing', detail: { name: o.name, strike: m.strike } };
        /* the strike is the HOME side's handicap (Novig: "A spread's line is the home side's handicap") */
        var want = who === 'home' ? strike : negate(strike);
        if (p.line !== want) return { reason: 'spread_orientation_mismatch', detail: { name: o.name, who: who, strike: m.strike, expected: want } };
        outs.push({ outcome_id: o.outcomeId, novig_name: o.name, who: who, side: who === 'home' ? ev.home_team : ev.away_team, point: p.line });
      }
    }
    if (outs[0].side === outs[1].side) return { reason: 'both_outcomes_one_side', detail: { names: m.outcomes.map(function (o) { return o.name; }) } };
    var notes = [], ordinaryNote = false;
    if (m.voids === 'FMV') notes.push('Novig settles a voided market at its fair market value (voids: FMV); a sportsbook normally refunds a void. The prices compare for a completed game, not for a void.');
    else if (m.voids === 'PUSH') notes.push('Novig refunds every fill if this market voids (voids: PUSH), as a sportsbook normally does.');
    else notes.push('Novig did not state how this market voids.');
    if (T.shape === 'teams' && ev.league === 'NFL') {
      notes.push('An NFL game can end tied. A sportsbook moneyline refunds a tie; Novig does not document how a two-way NFL moneyline settles one.');
      ordinaryNote = true;
    }
    if (T.shape !== 'teams' && /^-?\d+$/.test(String(strike))) notes.push('A whole-number line can push: both venues return the stake on a push (Novig grades "Pushes").');
    if (T.period === 'first_half') notes.push('First half only: overtime is not part of it at either venue.');
    var constraints = {
      league: ev.league, sport_key: ev.odds_sport_key, market_kind: T.book_market, period: T.period, line: T.shape === 'teams' ? null : strike,
      orientation: 'home_away_same', ot: T.period === 'first_half' ? 'excluded' : 'included_two_way', void_rule: { novig: m.voids || null, book: 'sportsbook house rules (refund on a void)' },
      kickoff_delta_min: ev.kickoff_delta_min, novig_market_type: m.marketType, novig_strike: m.strike == null ? null : String(m.strike)
    };
    return {
      link: {
        novig_market_id: m.marketId, novig_event_id: ev.novig_event_id, novig_market_type: m.marketType, odds_event_id: ev.odds_event_id, odds_sport_key: ev.odds_sport_key,
        book_market: T.book_market, period: T.period, line: T.shape === 'teams' ? null : strike, home_team: ev.home_team, away_team: ev.away_team, kickoff_at: ev.kickoff_at,
        outcomes: outs.map(function (x) { return { outcome_id: x.outcome_id, novig_name: x.novig_name, side: x.side, point: x.point }; }),
        match_confidence: ev.strong && !ordinaryNote ? 'high' : 'medium',
        match_method: ev.method + '|market:' + m.marketType + (strike != null && T.shape !== 'teams' ? '@' + strike : ''),
        constraints: constraints, settlement_notes: notes, linker_version: LINKER_VERSION
      }
    };
  }

  /** every market of one Novig event; markets whose type is unsupported are counted, not queued */
  function mapEvent(ev, participants, markets, books) {
    var e = matchEvent(ev, participants, books);
    var mine = (markets || []).filter(function (m) { return m.eventId === ev.eventId; });
    if (!e.event) return { links: [], unmapped: mine.filter(function (m) { return MARKET_TYPES[m.marketType]; }).map(function (m) { return { novig_market_id: m.marketId, novig_event_id: ev.eventId, reason: e.reason, detail: e.detail || null }; }), event_reason: e.reason, event_detail: e.detail || null };
    var links = [], unmapped = [], unsupported = 0;
    mine.forEach(function (m) {
      if (!MARKET_TYPES[m.marketType]) { unsupported++; return; }
      var r = mapMarket(m, e.event);
      if (r.link) links.push(r.link); else unmapped.push({ novig_market_id: m.marketId, novig_event_id: ev.eventId, reason: r.reason, detail: r.detail || null });
    });
    return { event: e.event, links: links, unmapped: unmapped, unsupported: unsupported };
  }

  return { LINKER_VERSION: LINKER_VERSION, LEAGUES: LEAGUES, MARKET_TYPES: MARKET_TYPES, line: line, negate: negate, parseOutcome: parseOutcome,
    pairMatch: pairMatch, nflCompetitor: nflCompetitor, matchEvent: matchEvent, mapMarket: mapMarket, mapEvent: mapEvent, hasIdentity: !!FI };
});
