#!/usr/bin/env node
/* ===========================================================================
   lib/novig_market_map.js — is this Novig market the same bet as the book's?

   The markets are REAL: tools/novig/fixtures/catalog_nfl_2026-10-30.json is
   Novig's production public catalog for BAL @ BUF and KC @ DEN, read
   2026-10-30. The participants route is signed, so the participants below
   are written for the test in the shape GET /v3/catalog/participants
   documents (ParticipantsResponse); the book events stand in for
   public.signals' h2h rows.

     event       both teams, same home/away, inside the sport's tolerance;
                 a swapped listing, one team only, two candidate games (a
                 doubleheader), no game, the wrong league are each refused
     teams       NFL by symbol AND name (a conflict is refused); college by
                 the shared identity (mascots, "Ohio St."; Ohio ≠ Ohio State);
                 the daily leagues by exact full name only (LA ≠ Los Angeles
                 is refused, not guessed)
     markets     every real MONEY/SPREAD/TOTAL/_1H market of BAL @ BUF maps;
                 the strike is the home handicap; a −4.5 outcome under a −3.5
                 strike, an Over 48 under 47.5, a moneyline with a line, a
                 three-way market are each refused
     settlement  FMV voids, an NFL moneyline tie and whole-number pushes are
                 carried as notes; an NFL moneyline is never 'high'
     ids         a re-listed game (new Novig ids) links to the same book event

   Run: node tools/novig/market_map.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const M = require(path.join(__dirname, '..', '..', 'lib', 'novig_market_map.js'));
const F = require(path.join(__dirname, 'fixtures', 'catalog_nfl_2026-10-30.json'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }

chk('identity: lib/football_identity.js is loaded beside the matcher', M.hasIdentity);

const EV_BUF = F.events.find((e) => e.description === 'Baltimore Ravens @ Buffalo Bills');
const EV_DEN = F.events.find((e) => e.description === 'Kansas City Chiefs @ Denver Broncos');
const comp = (id, name, shortName, symbol) => ({ competitorId: id, name, shortName, symbol, marketIds: [] });
const P_BUF = { eventId: EV_BUF.eventId, homeCompetitorId: 'c-buf', awayCompetitorId: 'c-bal', players: [], competitors: [comp('c-buf', 'Buffalo Bills', 'Bills', 'BUF'), comp('c-bal', 'Baltimore Ravens', 'Ravens', 'BAL')] };
const P_DEN = { eventId: EV_DEN.eventId, homeCompetitorId: 'c-den', awayCompetitorId: 'c-kc', players: [], competitors: [comp('c-den', 'Denver Broncos', 'Broncos', 'DEN'), comp('c-kc', 'Kansas City Chiefs', 'Chiefs', 'KC')] };
const book = (id, sk, home, away, ms) => ({ event_id: id, sport_key: sk, home, away, kickoff_ms: ms });
const BOOKS = [
  book('odds-bufbal', 'americanfootball_nfl', 'Buffalo Bills', 'Baltimore Ravens', EV_BUF.startsTs),
  book('odds-denkc', 'americanfootball_nfl', 'Denver Broncos', 'Kansas City Chiefs', EV_DEN.startsTs + 5 * 60000),
  book('odds-decoy', 'americanfootball_nfl', 'Buffalo Bills', 'Miami Dolphins', EV_BUF.startsTs + 7 * 864e5),
];

/* ---------------------------------------------------------------- lines */
chk('line: canonical decimal strings', M.line('-3.50') === '-3.5' && M.line('+3') === '3' && M.line('0') === '0' && M.line('-0') === '0' && M.line('47.5') === '47.5' && M.line('x') === null && M.negate('-3.5') === '3.5' && M.negate('3') === '-3');
chk('outcome names: "BUF -3.5", "BAL +3.5", "Over 47.5", "BUF"', JSON.stringify(M.parseOutcome('BUF -3.5')) === '{"team":"BUF","line":"-3.5"}' && JSON.stringify(M.parseOutcome('BAL +3.5')) === '{"team":"BAL","line":"3.5"}'
  && JSON.stringify(M.parseOutcome('Over 47.5')) === '{"ou":"Over","line":"47.5"}' && JSON.stringify(M.parseOutcome('BUF')) === '{"team":"BUF","line":null}');

/* ---------------------------------------------------------------- the real BAL @ BUF catalog */
const r = M.mapEvent(EV_BUF, P_BUF, F.markets, BOOKS);
const mine = F.markets.filter((m) => m.eventId === EV_BUF.eventId);
chk('event: BAL @ BUF links to its one book event (both teams, home Buffalo, same kickoff)', r.event && r.event.odds_event_id === 'odds-bufbal' && r.event.home_team === 'Buffalo Bills' && r.event.kickoff_delta_min === 0 && r.event.strong, r.event_reason);
chk('markets: every real game-line market of the event maps (' + mine.length + ')', r.links.length === mine.length && r.unmapped.length === 0, r.unmapped.slice(0, 5));
const byId = Object.fromEntries(r.links.map((l) => [l.novig_market_id, l]));
const realMoney = mine.find((m) => m.marketType === 'MONEY');
const lm = byId[realMoney.marketId];
chk('moneyline: MONEY -> h2h, full game; "BUF" is Buffalo Bills, "BAL" Baltimore Ravens; no line', lm.book_market === 'h2h' && lm.period === 'game' && lm.line === null
  && lm.outcomes.find((o) => o.novig_name === 'BUF').side === 'Buffalo Bills' && lm.outcomes.find((o) => o.novig_name === 'BAL').side === 'Baltimore Ravens');
chk('moneyline: an NFL moneyline is medium (a tie is undocumented at Novig) and says so', lm.match_confidence === 'medium' && lm.settlement_notes.some((n) => /tied/.test(n)) && lm.settlement_notes.some((n) => /FMV/.test(n)));
const realSpread = mine.find((m) => m.marketType === 'SPREAD' && m.strike === '-3.5');
const ls = byId[realSpread.marketId];
chk('spread: "BUF -3.5" is Buffalo −3.5 (the home handicap), "BAL +3.5" is Baltimore +3.5; high', ls.book_market === 'spreads' && ls.line === '-3.5' && ls.match_confidence === 'high'
  && ls.outcomes.find((o) => o.side === 'Buffalo Bills').point === '-3.5' && ls.outcomes.find((o) => o.side === 'Baltimore Ravens').point === '3.5', ls);
const realTotal = mine.find((m) => m.marketType === 'TOTAL');
const lt = byId[realTotal.marketId];
chk('total: Over and Under at the strike, sides as the book names them', lt.book_market === 'totals' && lt.outcomes.map((o) => o.side).sort().join(',') === 'Over,Under' && lt.outcomes.every((o) => o.point === M.line(realTotal.strike)));
const real1H = mine.find((m) => m.marketType === 'TOTAL_1H');
chk('period: a first-half total maps to totals_h1 (never to the full-game totals), with its note', byId[real1H.marketId].book_market === 'totals_h1' && byId[real1H.marketId].period === 'first_half' && byId[real1H.marketId].settlement_notes.some((n) => /First half/.test(n)));
chk('every link records the constraints it was verified on and its linker version', r.links.every((l) => l.constraints.orientation === 'home_away_same' && l.constraints.void_rule.novig === 'FMV' && l.linker_version === M.LINKER_VERSION && l.constraints.kickoff_delta_min === 0));
chk('every spread line is the home handicap, read from both outcomes', r.links.filter((l) => l.book_market === 'spreads').every((l) => {
  const h = l.outcomes.find((o) => o.side === 'Buffalo Bills'), a = l.outcomes.find((o) => o.side === 'Baltimore Ravens');
  return h.point === l.line && a.point === M.negate(l.line);
}));

/* ---------------------------------------------------------------- KC @ DEN, kickoff 5 min apart */
const r2 = M.mapEvent(EV_DEN, P_DEN, F.markets, BOOKS);
chk('event: KC @ DEN links with the book 5 minutes apart (high)', r2.event && r2.event.odds_event_id === 'odds-denkc' && r2.event.kickoff_delta_min === 5 && r2.event.strong);

/* ---------------------------------------------------------------- refusals */
const money = (over) => Object.assign({}, realMoney, over || {});
const spread = (names, strike) => Object.assign({}, realSpread, { strike, outcomes: realSpread.outcomes.map((o, i) => Object.assign({}, o, { name: names[i] })) });
chk('different spread: a "BUF -4.5" outcome under a −3.5 strike is refused (orientation/line)', M.mapMarket(spread(['BUF -4.5', 'BAL +4.5'], '-3.5'), r.event).reason === 'spread_orientation_mismatch');
chk('orientation: "BUF +3.5" under a −3.5 strike (home handicap) is refused', M.mapMarket(spread(['BUF +3.5', 'BAL -3.5'], '-3.5'), r.event).reason === 'spread_orientation_mismatch');
chk('different total: an "Over 48" outcome under a 47.5 strike is refused', M.mapMarket(Object.assign({}, realTotal, { strike: '47.5', outcomes: [{ outcomeId: 'o', name: 'Over 48' }, { outcomeId: 'u', name: 'Under 47.5' }] }), r.event).reason === 'total_line_mismatch');
chk('overtime: a three-way (regulation) market is unsupported, never mapped to h2h', M.mapMarket(money({ marketType: 'MONEYLINE_3_WAY_WIN' }), r.event).reason === 'unsupported_market_type');
chk('moneyline: an outcome with a line is refused; three outcomes are refused', M.mapMarket(money({ outcomes: [{ outcomeId: 'a', name: 'BUF -1' }, { outcomeId: 'b', name: 'BAL' }] }), r.event).reason === 'moneyline_with_a_line'
  && M.mapMarket(money({ outcomes: [{ outcomeId: 'a', name: 'BUF' }, { outcomeId: 'b', name: 'BAL' }, { outcomeId: 'c', name: 'Draw' }] }), r.event).reason === 'not_two_outcomes');
chk('ambiguous outcome: a name that is neither team, or both outcomes the same team, is refused', M.mapMarket(money({ outcomes: [{ outcomeId: 'a', name: 'Bills Mafia' }, { outcomeId: 'b', name: 'BAL' }] }), r.event).reason === 'outcome_team_unresolved'
  && M.mapMarket(money({ outcomes: [{ outcomeId: 'a', name: 'BUF' }, { outcomeId: 'b', name: 'Buffalo Bills' }] }), r.event).reason === 'both_outcomes_one_side');
chk('settlement: a PUSH market says so; a whole-number spread notes the push', M.mapMarket(spread(['BUF -3', 'BAL +3'], '-3'), r.event).link.settlement_notes.some((n) => /push/.test(n))
  && M.mapMarket(Object.assign(spread(['BUF -3.5', 'BAL +3.5'], '-3.5'), { voids: 'PUSH' }), r.event).link.settlement_notes.some((n) => /refunds every fill/.test(n)));
chk('league: a CFL event is unsupported; an NFL event finds no NCAAF book game', M.matchEvent(Object.assign({}, EV_BUF, { league: 'CFL' }), P_BUF, BOOKS).reason === 'unsupported_league'
  && M.matchEvent(EV_BUF, P_BUF, BOOKS.map((b) => Object.assign({}, b, { sport_key: 'americanfootball_ncaaf' }))).reason === 'no_book_event');
chk('event: a swapped home/away listing is refused (a spread strike is the home handicap)', M.matchEvent(EV_BUF, P_BUF, [book('x', 'americanfootball_nfl', 'Baltimore Ravens', 'Buffalo Bills', EV_BUF.startsTs)]).reason === 'home_away_swapped');
chk('event: one team only is refused and named', M.matchEvent(EV_BUF, P_BUF, [book('x', 'americanfootball_nfl', 'Buffalo Bills', 'Miami Dolphins', EV_BUF.startsTs)]).reason === 'one_team_only');
chk('event: two book games with both teams inside the tolerance is ambiguous, never picked', M.matchEvent(EV_BUF, P_BUF, [BOOKS[0], book('dup', 'americanfootball_nfl', 'Buffalo Bills', 'Baltimore Ravens', EV_BUF.startsTs + 3600e3)]).reason === 'ambiguous_book_event');
chk('event: no home/away in the participants is refused', M.matchEvent(EV_BUF, { competitors: P_BUF.competitors }, BOOKS).reason === 'no_home_away');
chk('NFL: a symbol and a name that disagree (KC / Buffalo Bills) are refused', M.matchEvent(EV_BUF, Object.assign({}, P_BUF, { competitors: [comp('c-buf', 'Buffalo Bills', 'Bills', 'KC'), P_BUF.competitors[1]] }), BOOKS).reason !== undefined
  && M.nflCompetitor({ name: 'Buffalo Bills', symbol: 'KC' }).reason === 'competitor_symbol_name_conflict');
chk('NFL: a 30-hour reschedule still links, at medium', (() => { const e = M.matchEvent(EV_BUF, P_BUF, [book('moved', 'americanfootball_nfl', 'Buffalo Bills', 'Baltimore Ravens', EV_BUF.startsTs + 30 * 3600e3)]); return e.event && !e.event.strong && e.event.kickoff_delta_min === 1800; })());
chk('ids: a re-listed game (new Novig event and market ids) links to the same book event', (() => {
  const ev2 = Object.assign({}, EV_BUF, { eventId: 'novig-relisted' });
  const ms2 = mine.slice(0, 3).map((m, i) => Object.assign({}, m, { eventId: 'novig-relisted', marketId: 'new-' + i }));
  const x = M.mapEvent(ev2, Object.assign({}, P_BUF, { eventId: 'novig-relisted' }), ms2, BOOKS);
  return x.event.odds_event_id === 'odds-bufbal' && x.links.length === 3 && x.links.every((l) => /^new-/.test(l.novig_market_id));
})());

/* ---------------------------------------------------------------- college football and the daily leagues */
const t0 = Date.parse('2026-10-31T19:30:00Z');
const cfbEv = { eventId: 'cfb1', league: 'NCAAF', startsTs: t0 };
const cfbP = (home, away) => ({ homeCompetitorId: 'h', awayCompetitorId: 'a', competitors: [comp('h', home, null, null), comp('a', away, null, null)] });
const CFB_BOOKS = [book('cfb-osu', 'americanfootball_ncaaf', 'Ohio State Buckeyes', 'Texas Longhorns', t0), book('cfb-decoy', 'americanfootball_ncaaf', 'Ohio Bobcats', 'Texas Tech Red Raiders', t0)];
const c1 = M.matchEvent(cfbEv, cfbP('Ohio State Buckeyes', 'Texas Longhorns'), CFB_BOOKS);
const c2 = M.matchEvent(cfbEv, cfbP('Ohio St.', 'Texas'), CFB_BOOKS);
chk('college: the full names match (high); the decoy Ohio / Texas Tech game is left alone', c1.event && c1.event.odds_event_id === 'cfb-osu' && c1.event.strong);
chk('college: "Ohio St." and "Texas" resolve through the shared identity to the same game (medium)', c2.event && c2.event.odds_event_id === 'cfb-osu' && !c2.event.strong, c2);
const nbaEv = { eventId: 'nba1', league: 'NBA', startsTs: t0 };
const nbaP = (home, away) => ({ homeCompetitorId: 'h', awayCompetitorId: 'a', competitors: [comp('h', home, null, 'X'), comp('a', away, null, 'Y')] });
const NBA_BOOKS = [book('nba-1', 'basketball_nba', 'Los Angeles Clippers', 'Boston Celtics', t0)];
chk('NBA: exact full names link', M.matchEvent(nbaEv, nbaP('Los Angeles Clippers', 'Boston Celtics'), NBA_BOOKS).event.odds_event_id === 'nba-1');
chk('NBA: "LA Clippers" is not guessed to be "Los Angeles Clippers"', M.matchEvent(nbaEv, nbaP('LA Clippers', 'Boston Celtics'), NBA_BOOKS).reason === 'one_team_only');
chk('NBA: a game five hours away is outside the 4-hour tolerance', M.matchEvent(nbaEv, nbaP('Los Angeles Clippers', 'Boston Celtics'), [book('nba-2', 'basketball_nba', 'Los Angeles Clippers', 'Boston Celtics', t0 + 5 * 3600e3)]).reason === 'no_book_event');
const mlbEv = { eventId: 'mlb1', league: 'MLB', startsTs: t0 };
chk('MLB: a doubleheader (two book games three hours apart) is ambiguous', M.matchEvent(mlbEv, nbaP('New York Yankees', 'Boston Red Sox'), [book('g1', 'baseball_mlb', 'New York Yankees', 'Boston Red Sox', t0), book('g2', 'baseball_mlb', 'New York Yankees', 'Boston Red Sox', t0 + 3 * 3600e3)]).reason === 'ambiguous_book_event');

console.log((fail ? 'FAILED' : 'ALL GREEN') + ' novig market map: ' + pass + ' passed, ' + fail + ' failed');
for (const f of failures) console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 700) : ''));
process.exit(fail ? 1 : 0);
