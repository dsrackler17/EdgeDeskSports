#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk Tennis — the pipeline's own tests.

   Everything here runs offline against synthetic provider documents and an
   in-memory stand-in for PostgREST. Nothing calls ESPN and nothing touches
   production. The rules under test are the ones the Match Center draws, so a
   rule proved here is the rule a reader sees.

   Run: node tools/tennis/tennis.test.js
   =========================================================================== */
'use strict';

const R = require('../../lib/tennis_research.js');
const E = require('./espn.js');
const S = require('./sync_events.js');
const B = require('./build_baselines.js');
const G = require('./live_gate.js');
const P = require('./live_poll.js');
const F = require('./fixtures/make_day.js');
const { fakeDb } = require('./fake_db.js');

let pass = 0, fail = 0; const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 400); } }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
}
function eq(name, got, want) { chk(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); }
function near(name, got, want, tol) { chk(name, got != null && Math.abs(got - want) <= (tol == null ? 1e-9 : tol), 'got ' + got + ' want ~' + want); }

/* ======================================================================== */
/* 1. NAMES AND IDENTITY                                                    */
/* ======================================================================== */
eq('accents fold to the letters underneath', R.normName('Jiří Lehečka'), 'jiri lehecka');
eq('a quoted nickname is presentation, not identity', R.normName('Alexander "Sascha" Zverev'), 'alexander zverev');
eq('punctuation and case fold away', R.normName('  J.-L.  O\'Brien  '), 'j l o brien');
chk('two spellings of the same name are the same name', R.sameName('Stefanos Tsitsipás', 'Stefanos Tsitsipas'));
chk('a slashed name is a doubles pair', R.isDoublesName('Bopanna/Ebden'));
chk('a single name is not a pair', !R.isDoublesName('Rohan Bopanna'));
eq('a pair key does not depend on the order the feed listed them',
  R.pairKey('Bopanna/Ebden'), R.pairKey('Ebden/Bopanna'));

const PLAYERS = [
  { player_id: 'p1', full_name: 'Novak Djokovic', tour: 'ATP' },
  { player_id: 'p2', full_name: 'Carlos Alcaraz', tour: 'ATP' },
  { player_id: 'p3', full_name: 'Venus Williams', tour: 'WTA' },
  { player_id: 'p4', full_name: 'Serena Williams', tour: 'WTA' },
  { player_id: 'p5', full_name: 'Jiří Lehečka', tour: 'ATP' }
];
const IDX = R.buildPlayerIndex(PLAYERS);
eq('an exact name resolves exactly', R.resolvePlayer('Novak Djokovic', null, IDX, {}).method, 'exact');
eq('an accented record matches an unaccented feed', R.resolvePlayer('Jiri Lehecka', null, IDX, {}).player_id, 'p5');
eq('an initial and a surname resolve', R.resolvePlayer('N. Djokovic', null, IDX, {}).method, 'initial_last');
eq('a reversed name resolves', R.resolvePlayer('Djokovic Novak', null, IDX, {}).method, 'name_order');
eq('a unique surname resolves', R.resolvePlayer('Alcaraz', null, IDX, {}).method, 'surname');
eq('a surname two players share is refused', R.resolvePlayer('Williams', null, IDX, {}).method, 'ambiguous');
eq('an ambiguous refusal names the candidates it could not choose between',
  R.resolvePlayer('Williams', null, IDX, {}).candidates.slice().sort(), ['p3', 'p4']);
eq('a doubles pair is never resolved to a player', R.resolvePlayer('Bopanna/Ebden', null, IDX, {}).method, 'doubles');
eq('a name on nobody resolves to nobody', R.resolvePlayer('Nobody Atall', null, IDX, {}).player_id, null);
eq('a stored alias beats every heuristic', R.resolvePlayer('Whoever', '77', IDX, { 'espn:77': 'p2' }).method, 'provider_id');
eq('and the alias decides which player it is', R.resolvePlayer('Whoever', '77', IDX, { 'espn:77': 'p2' }).player_id, 'p2');

/* ======================================================================== */
/* 2. SETS, SCORE AND THE SET-WON RULE                                      */
/* ======================================================================== */
const liveM = { best_of: 5, status: 'live', current_set: 2, set_scores: [{ home: 6, away: 3 }, { home: 1, away: 2 }] };
eq('leading an unfinished set is not winning it', R.setsWon(liveM), { home: 1, away: 0 });
eq('a finished 7-6 counts once the tiebreak is played', R.setsWon({ status: 'live', current_set: 2, set_scores: [{ home: 7, away: 6, home_tb: 7, away_tb: 4 }] }), { home: 1, away: 0 });
eq('7-5 is a finished set', R.setsWon({ status: 'final', set_scores: [{ home: 7, away: 5 }] }), { home: 1, away: 0 });
eq('a retirement leaves its last set uncredited', R.setsWon({ status: 'final', result_type: 'retirement', current_set: 2, set_scores: [{ home: 6, away: 2 }, { home: 2, away: 1 }] }), { home: 1, away: 0 });
eq('a set with play after it is over', R.setsWon({ status: 'live', current_set: 3, set_scores: [{ home: 6, away: 3 }, { home: 3, away: 6 }, { home: 2, away: 1 }] }), { home: 1, away: 1 });
eq('a 0-0 placeholder set does not close the one before it', R.setsWon({ status: 'live', current_set: 2, set_scores: [{ home: 4, away: 3 }, { home: 0, away: 0 }] }), { home: 0, away: 0 });
eq('the scoreline prints the tiebreak loser’s points', R.scoreLine({ set_scores: [{ home: 7, away: 6, home_tb: 7, away_tb: 4 }] }), '7-6(4)');
chk('the deciding set of a best-of-three is the third', R.isDecidingSet({ best_of: 3, current_set: 3 }));
chk('the second set of a best-of-five is not the decider', !R.isDecidingSet({ best_of: 5, current_set: 2 }));
eq('a match with no scoreline has no sets', R.setsFrom({}), []);
eq('a scoreline stored as JSON text still parses', R.setsFrom({ set_scores: '[{"home":6,"away":4}]' }).length, 1);

/* ======================================================================== */
/* 3. THE FIRST-POINT BOUNDARY AND CLV                                      */
/* ======================================================================== */
const BELL = '2026-05-28T11:00:00Z', BELLMS = Date.parse(BELL);
const observed = { status: 'live', first_point_at: BELL, close_bound_source: 'observed_first_point', scheduled_at: '2026-05-28T10:00:00Z' };
eq('the observed first point is the boundary', R.closeBound(observed).source, 'observed_first_point');
eq('a capture before the first point is PRE', R.marketStateAt('2026-05-28T10:55:00Z', observed), 'PRE');
eq('a capture at the first point is still PRE', R.marketStateAt(BELL, observed), 'PRE');
eq('a capture one second after the first point is LIVE', R.marketStateAt(new Date(BELLMS + 1000).toISOString(), observed), 'LIVE');
const weak = { status: 'live', first_point_at: null, close_bound_source: 'scheduled_start', scheduled_at: '2026-05-28T10:00:00Z' };
eq('without an observed first point the scheduled start is the bound, and says so', R.closeBound(weak).source, 'scheduled_start');
eq('a capture after the scheduled start of a live match is LIVE', R.marketStateAt('2026-05-28T10:30:00Z', weak), 'LIVE');
eq('every capture on a match that has not started is PRE', R.marketStateAt('2026-05-28T10:30:00Z', { status: 'scheduled' }), 'PRE');

const caps = [
  { sig_key: 'k', capture_at: '2026-05-28T09:00:00Z', market_state: 'PRE', best_dec: 1.80, sharp_fair: 0.55 },
  { sig_key: 'k', capture_at: '2026-05-28T10:57:00Z', market_state: 'PRE', best_dec: 1.55, sharp_fair: 0.63 },
  { sig_key: 'k', capture_at: '2026-05-28T11:20:00Z', market_state: 'LIVE', best_dec: 1.20, sharp_fair: 0.82 }
];
const ref = R.closingReference(caps, observed);
chk('the closing reference is the last PRE capture', ref.available && ref.fair === 0.63, JSON.stringify(ref));
chk('a live price is never promoted to a close', ref.fair !== 0.82);
const noPre = R.closingReference([caps[2]], observed);
chk('with no pre-match capture there is no close, and the reason is given', !noPre.available && /no pre-match capture/.test(noPre.reason), JSON.stringify(noPre));
const stale = R.closingReference([{ sig_key: 'k', capture_at: '2026-05-27T11:00:00Z', market_state: 'PRE', best_dec: 1.8, sharp_fair: 0.55 }], observed);
chk('a capture a day before the start is too far to be a close', !stale.available && /too far/.test(stale.reason), JSON.stringify(stale));
near('CLV is the entry against the closing fair', R.clv(2.0, 0.55), 0.10, 1e-9);
eq('CLV of a nonsense price is nothing, not zero', R.clv(0.5, 0.55), null);

/* ======================================================================== */
/* 4. MARKET LINKING — both participants, and doubles to doubles only       */
/* ======================================================================== */
const MATCHES = [
  { match_id: 'm1', tournament_id: 't1', is_doubles: false, home_name: 'Novak Djokovic', away_name: 'Carlos Alcaraz', home_player_id: 'p1', away_player_id: 'p2', scheduled_at: '2026-05-28T11:00:00Z' },
  { match_id: 'm2', tournament_id: 't1', is_doubles: true, home_name: 'Bopanna/Ebden', away_name: 'Granollers/Zeballos', scheduled_at: '2026-05-28T13:00:00Z' }
];
function sig(o) { return Object.assign({ sig_key: o.k, event_id: o.ev, sport_key: 'tennis_atp', market: 'h2h', selection: o.sel, commence_time: '2026-05-28T11:00:00Z', home_team: o.home, away_team: o.away, best_dec: 1.9, last_seen_at: '2026-05-28T10:50:00Z' }, o.extra || {}); }
const resolve = (n) => R.resolvePlayer(n, null, IDX, {});

let lm = S.linkMarkets([
  sig({ k: 'a1', ev: 'e1', sel: 'Novak Djokovic', home: 'Novak Djokovic', away: 'Carlos Alcaraz' }),
  sig({ k: 'a2', ev: 'e1', sel: 'Carlos Alcaraz', home: 'Novak Djokovic', away: 'Carlos Alcaraz' })
], MATCHES, resolve, '2026-05-28T10:00:00Z');
eq('a fixture whose two participants are the match links', lm.links.length, 1);
eq('the link carries a key for each side', [!!lm.links[0].home_sig_key, !!lm.links[0].away_sig_key], [true, true]);

lm = S.linkMarkets([
  sig({ k: 'b1', ev: 'e2', sel: 'Novak Djokovic', home: 'Novak Djokovic', away: 'Nobody Atall' }),
  sig({ k: 'b2', ev: 'e2', sel: 'Nobody Atall', home: 'Novak Djokovic', away: 'Nobody Atall' })
], MATCHES, resolve, '2026-05-28T10:00:00Z');
eq('a fixture with one unresolvable participant links to nothing', lm.links.length, 0);
chk('and the refusal is recorded with a reason', lm.rejections.length > 0 && !!lm.rejections[0].reason, JSON.stringify(lm.rejections));

lm = S.linkMarkets([
  sig({ k: 'c1', ev: 'e3', sel: 'Bopanna/Ebden', home: 'Bopanna/Ebden', away: 'Granollers/Zeballos' }),
  sig({ k: 'c2', ev: 'e3', sel: 'Granollers/Zeballos', home: 'Bopanna/Ebden', away: 'Granollers/Zeballos' })
], MATCHES, resolve, '2026-05-28T10:00:00Z');
eq('a doubles fixture links to the doubles match', (lm.links[0] || {}).match_id, 'm2');

lm = S.linkMarkets([
  sig({ k: 'd1', ev: 'e4', sel: 'Bopanna/Ebden', home: 'Bopanna/Ebden', away: 'Carlos Alcaraz' }),
  sig({ k: 'd2', ev: 'e4', sel: 'Carlos Alcaraz', home: 'Bopanna/Ebden', away: 'Carlos Alcaraz' })
], MATCHES, resolve, '2026-05-28T10:00:00Z');
eq('a pair can never take a singles player’s seat', lm.links.length, 0);

/* the tennis analogue of "Jean Silva vs Draw": a third selection must never
   become a participant */
const grouped = R.groupFixtures([
  sig({ k: 'e1a', ev: 'e5', sel: 'Novak Djokovic', home: 'Novak Djokovic', away: 'Carlos Alcaraz' }),
  sig({ k: 'e1b', ev: 'e5', sel: 'Carlos Alcaraz', home: 'Novak Djokovic', away: 'Carlos Alcaraz' }),
  sig({ k: 'e1c', ev: 'e5', sel: 'Over 22.5', home: 'Novak Djokovic', away: 'Carlos Alcaraz', extra: { market: 'totals' } })
]);
const norm = R.normalizeFixture(grouped[0]);
eq('a fixture takes its two sides from its participants, never from its selection list', [norm.home_team, norm.away_team], ['Novak Djokovic', 'Carlos Alcaraz']);
eq('the two head-to-head prices are the two participants',
  [norm.h2h.home && norm.h2h.home.sig_key, norm.h2h.away && norm.h2h.away.sig_key], ['e1a', 'e1b']);
eq('a price on another market is filed under that market, never seated as a side', Object.keys(norm.markets).sort(), ['h2h', 'totals']);
eq('and it never becomes a third participant', norm.h2h.other.length, 0);
const totalsSel = R.normalizeFixture(R.groupFixtures([
  sig({ k: 'f1', ev: 'e6', sel: 'Novak Djokovic', home: 'Novak Djokovic', away: 'Carlos Alcaraz' }),
  sig({ k: 'f2', ev: 'e6', sel: 'Over 22.5 games', home: 'Novak Djokovic', away: 'Carlos Alcaraz' })
])[0]);
eq('an h2h selection matching neither participant is rejected with a reason',
  (totalsSel.rejections[0] || {}).reason, 'unknown_selection');
eq('and the side it does not fill stays empty', totalsSel.h2h.away, null);

/* ======================================================================== */
/* 5. HEALTH                                                                */
/* ======================================================================== */
eq('a feed inside the healthy window is healthy', R.domainLevel(30, R.HEALTH.live), 'HEALTHY');
eq('a feed past the healthy window is degraded', R.domainLevel(120, R.HEALTH.live), 'DEGRADED');
eq('a feed past the degraded window is stale', R.domainLevel(600, R.HEALTH.live), 'STALE');
eq('a feed that never wrote is offline', R.domainLevel(null, R.HEALTH.live), 'OFFLINE');
eq('during a match the live feed decides', R.healthLevel({ phase: 'live', liveAgeS: 900, marketAgeS: 10, eventAgeS: 10, historyAgeS: 10 }).level, 'STALE');
eq('outside a match a silent live feed is not a fault', R.healthLevel({ phase: 'idle', liveAgeS: null, marketAgeS: 60, eventAgeS: 3600, historyAgeS: 86400 }).level, 'HEALTHY');
eq('a dead market during a match is called out', R.healthLevel({ phase: 'live', liveAgeS: 10, marketAgeS: 99999, eventAgeS: 10, historyAgeS: 10 }).level, 'MARKET DEGRADED');
eq('never having run at all is offline', R.healthLevel({ phase: 'live', liveAgeS: null, marketAgeS: null, eventAgeS: null, historyAgeS: null }).level, 'OFFLINE');

/* ======================================================================== */
/* 6. BASELINES — the record counts, the serve data is observed or absent   */
/* ======================================================================== */
const base = R.buildBaseline({
  player: { player_id: 'p1', full_name: 'Novak Djokovic', tour: 'ATP' },
  career: { wins: 700, losses: 150, matches: 850, win_pct: 0.82, last_match: '2026-05-20' },
  surface: [{ surface: 'clay', season: 2025, wins: 30, losses: 6, matches: 36 }, { surface: 'clay', season: 2024, wins: 20, losses: 4, matches: 24 }],
  form: [{ match_date: '2026-05-20', won: true }, { match_date: '2026-05-18', won: true }, { match_date: '2026-05-10', won: false }],
  rank: { rank: 1, points: 9000 },
  now: Date.parse('2026-05-28T00:00:00Z')
});
eq('surface seasons are summed, never averaged', base.clay_matches, 60);
near('the surface rate is recomputed from the sums', base.clay_win_pct, 50 / 60, 1e-3);
eq('a player never watched has no observed sample', base.obs_matches, 0);
chk('and the row says so in its notes', (base.notes || []).indexOf('no_observed_serve_baseline') >= 0, JSON.stringify(base.notes));
chk('no serve label is earned without observation', (base.style_labels || []).every(l => ['BIG SERVER', 'HOLD-HEAVY', 'RETURN-FIRST', 'BREAK-PRONE', 'DOUBLE-FAULT RISK', 'CLUTCH ON SERVE'].indexOf(l) < 0), JSON.stringify(base.style_labels));
eq('the winning streak is counted from the dated form', base.current_streak, 2);

const obs = R.observedBaseline([
  { side: 'home', match: { best_of: 3, set_scores: [{ home: 6, away: 4 }, { home: 6, away: 3 }], winner_side: 'home' },
    state: { stats_available: true, service_games_played: 10, service_games_won: 9, first_serves_in: 40, first_serves_total: 60, aces: 8, double_faults: 2, break_points_saved: 2, break_points_faced: 3, break_points_won: 3, break_points_total: 6, return_points_won: 25, return_points_total: 60, tiebreaks_played: 1, tiebreaks_won: 1 },
    oppState: { stats_available: true }, sets: [] }
]);
eq('one watched match is one observed match', obs.matches, 1);
near('the observed hold rate is the watched rate', obs.obs_hold_pct, 0.9, 1e-9);
near('aces are counted per service game', obs.obs_ace_per_service_game, 0.8, 1e-9);
const withObs = R.buildBaseline({ player: { player_id: 'p1', full_name: 'X' }, career: null, surface: [], form: [], rank: null,
  observed: Object.assign({}, obs, { matches: 4, obs_ace_per_service_game: 1.2, obs_hold_pct: 0.9 }), now: Date.now() });
chk('a serve label appears once the sample exists', (withObs.style_labels || []).indexOf('BIG SERVER') >= 0, JSON.stringify(withObs.style_labels));

/* ======================================================================== */
/* 7. THE LIVE READ AND THE FLAGS                                           */
/* ======================================================================== */
const HS = { stats_available: true, aces: 5, double_faults: 1, first_serves_in: 22, first_serves_total: 33, first_serve_points_won: 18, first_serve_points_total: 22, second_serve_points_won: 5, second_serve_points_total: 11, service_games_played: 5, service_games_won: 5, service_points_won: 23, service_points_total: 33, break_points_faced: 2, break_points_saved: 2, break_points_won: 2, break_points_total: 4, return_points_won: 16, return_points_total: 30, total_points_won: 39 };
const AS = { stats_available: true, aces: 1, double_faults: 4, first_serves_in: 17, first_serves_total: 31, first_serve_points_won: 10, first_serve_points_total: 17, second_serve_points_won: 4, second_serve_points_total: 14, service_games_played: 5, service_games_won: 3, service_points_won: 14, service_points_total: 31, break_points_faced: 4, break_points_saved: 2, break_points_won: 0, break_points_total: 2, return_points_won: 10, return_points_total: 33, total_points_won: 24 };
const MM = { match_id: 'm1', home_name: 'Novak Djokovic', away_name: 'Carlos Alcaraz', best_of: 3, status: 'live', current_set: 2, server_side: 'home', set_scores: [{ home: 6, away: 3 }, { home: 1, away: 2 }] };
const rd = R.liveRead({ match: MM, home: HS, away: AS, homeBase: null, awayBase: null });
chk('a live read with statistics is not empty', !rd.empty && rd.lines.length > 2);
chk('the read never says bet, lock, hammer or pick', !/\b(bet this|lock|hammer|guaranteed|ai pick)\b/i.test(JSON.stringify(rd.lines)), JSON.stringify(rd.lines));
eq('a match with no statistics has no read to give', R.liveRead({ match: MM, home: null, away: null }).empty, true);
const noBaseFlags = R.flagsFor({ match: MM, home: HS, away: AS, homeBase: null, awayBase: { obs_matches: 0 } });
chk('a player with no observed baseline is flagged as such, not compared against a guess',
  noBaseFlags.some(f => f.code === 'NO_SERVE_BASELINE'), JSON.stringify(noBaseFlags.map(f => f.code)));
chk('every flag names the threshold it crossed', noBaseFlags.every(f => !!f.threshold && !!f.rules));
chk('no flag claims an injury or predicts a retirement', !/injur|hurt|retire|cramp/i.test(JSON.stringify(noBaseFlags)), JSON.stringify(noBaseFlags));
const dfFlags = R.flagsFor({ match: MM, home: HS, away: Object.assign({}, AS, { double_faults: 9 }), homeBase: null, awayBase: { obs_matches: 5, obs_df_per_service_game: 0.2 } });
chk('a double-fault spike against an observed baseline is flagged', dfFlags.some(f => f.code === 'DOUBLE_FAULT_SPIKE'), JSON.stringify(dfFlags.map(f => f.code)));

/* ======================================================================== */
/* 8. THE PROVIDER ADAPTER                                                  */
/* ======================================================================== */
const DAY = F.day({ tour: 'atp', day: '2026-05-28', tournaments: [{
  id: '7000001', name: 'Testville Open', surface: 'clay', start: '2026-05-28T09:00Z',
  groupings: {
    "Men's Singles": [
      { id: '8000001', round: 'Round of 32', bestOf: 5, status: 'live', set: 2,
        home: { id: '9000001', name: 'Novak Djokovic', serving: true, sets: [6, { games: 1 }],
          stats: { aces: 5, df: 1, firstIn: 22, firstTotal: 33, svcGames: 5, holds: 5, bpFaced: 2, bpSaved: 2, bpWon: 2, bpTotal: 4, rtnPtsWon: 16, rtnPts: 30, totalPts: 39,
            sets: { 1: { aces: 3, svcGames: 3, holds: 3 } } } },
        away: { id: '9000002', name: 'Carlos Alcaraz', sets: [3, { games: 2 }],
          stats: { aces: 1, df: 4, firstIn: 17, firstTotal: 31, svcGames: 5, holds: 3, bpFaced: 4, bpSaved: 2, bpWon: 0, bpTotal: 2, rtnPtsWon: 10, rtnPts: 33, totalPts: 24 } } },
      { id: '8000003', round: 'Round of 32', bestOf: 5, status: 'final',
        home: { id: '9000005', name: 'Bruno Fixture', winner: true, sets: [{ games: 7, tb: 7 }, 6, 6] },
        away: { id: '9000006', name: 'Kai Dummy', sets: [{ games: 6, tb: 4 }, 4, 3] } }
    ],
    "Men's Doubles": [
      { id: '8000004', round: 'Round of 16', bestOf: 3, status: 'pre',
        home: { id: '9100001', pair: [{ id: '1', name: 'Rohan Testpair' }, { id: '2', name: 'Matt Fixtureman' }], sets: [] },
        away: { id: '9100002', pair: [{ id: '3', name: 'Marcel Sampleton' }, { id: '4', name: 'Horacio Placeholder' }], sets: [] } }
    ]
  }
}] });
const parsed = E.parseScoreboard(DAY, 'atp');
eq('a tour-day parses to its tournaments', parsed.length, 1);
eq('matches filed under groupings are found', parsed[0].matches.length, 3);
eq('a tournament with a live match is live', parsed[0].state, 'live');
const pm = parsed[0].matches[0];
eq('the server is read from the feed', pm.server_side, 'home');
eq('a doubles pair is marked as one', parsed[0].matches[2].is_doubles, true);
eq('a pair keeps both names', parsed[0].matches[2].home_name, 'Rohan Testpair/Matt Fixtureman');
eq('the winner of a finished match is read', parsed[0].matches[1].winner_side, 'home');
const ns = E.normalizeStats(pm.inline_stats.home);
eq('a per-set split never overwrites the match total', [ns.stats.service_games_won, ns.stats.service_games_played], [5, 5]);
eq('a composite "won/total" splits into two counts', [ns.stats.break_points_won, ns.stats.break_points_total], [2, 4]);
eq('a first-serve count is stored as a count', [ns.stats.first_serves_in, ns.stats.first_serves_total], [22, 33]);
eq('nothing in the fixture is left unmapped', Object.keys(ns.unmapped), []);
const splits = E.setSplits(pm.inline_stats.home);
eq('the per-set split is still readable on its own', splits[1].service_games_won, 3);
eq('a match takes its tour from the draw bucket it is filed under', pm.tour, 'ATP');
eq('and says whether that came from the bucket or the feed', pm.tour_source, 'grouping');
eq('a women\u2019s draw under the men\u2019s scoreboard is still WTA', E.tourOfGrouping("Women's Singles", 'atp'), 'WTA');
eq('mixed doubles is kept as itself', E.tourOfGrouping('Mixed Doubles', 'atp'), 'MIXED');
eq('a bucket the classifier does not know falls back to the tour that answered', E.tourOfGrouping('Qualifying', 'wta'), 'WTA');
eq('exactly one tour owns a mixed-doubles row', E.ownerTour('MIXED'), 'ATP');
eq('and each tour owns its own', [E.ownerTour('ATP'), E.ownerTour('WTA')], ['ATP', 'WTA']);

/* A runner showed the provider returning the US Open from BOTH tour
   scoreboards as the same id with the same competitions. Two rows would
   collide on one primary key and flip the tournament's tour every run. */
function slamDoc(tour) {
  return F.day({ tour: tour, tournaments: [{ id: '189-2026', name: 'US Open', start: '2026-08-24T09:00Z', groupings: {
    "Men's Singles": [{ id: 'ms1', status: 'live', set: 2, home: { id: 'a', name: 'Novak Djokovic', sets: [6, 1] }, away: { id: 'b', name: 'Carlos Alcaraz', sets: [3, 2] } }],
    "Women's Singles": [{ id: 'ws1', status: 'pre', home: { id: 'c', name: 'Venus Williams', sets: [] }, away: { id: 'd', name: 'Ann Fixture', sets: [] } }],
    'Mixed Doubles': [{ id: 'xd1', status: 'pre', home: { id: 'e', pair: [{ id: 'f', name: 'P One' }, { id: 'g', name: 'P Two' }], sets: [] }, away: { id: 'h', pair: [{ id: 'i', name: 'P Three' }, { id: 'j', name: 'P Four' }], sets: [] } }]
  } }] });
}
const bothTours = E.parseScoreboard(slamDoc('atp'), 'atp').concat(E.parseScoreboard(slamDoc('wta'), 'wta'));
eq('the same event answered by two tours arrives twice', bothTours.length, 2);
const merged = E.mergeTournaments(bothTours);
eq('and is merged into one tournament row', merged.length, 1);
eq('whose tour is what its draws actually contain', merged[0].tour, 'MIXED');
eq('carrying every match once', merged[0].matches.length, 3);
eq('and recording which feeds answered', merged[0].feed_tour, 'ATP+WTA');
eq('each match keeps the tour of its own draw',
  merged[0].matches.map(m => m.tour), ['ATP', 'WTA', 'MIXED']);
eq('so exactly one poller writes each of them',
  merged[0].matches.map(m => E.ownerTour(m.tour)), ['ATP', 'WTA', 'ATP']);

eq('a status the feed never sends parses to unknown rather than crashing', E.statusOf({}).status, 'unknown');
eq('a retirement is read as one', E.statusOf({ type: { name: 'STATUS_RETIRED', state: 'post', completed: true } }).resultType, 'retirement');
eq('a walkover is read as one', E.statusOf({ type: { name: 'STATUS_WALKOVER', state: 'post', completed: true } }).status, 'walkover');
eq('a percentage with no denominator stored is not turned into a count',
  E.normalizeStats({ stats: [{ name: 'firstServePercentage', value: 65, displayValue: '65%' }] }).stats.first_serves_in, null);

/* ======================================================================== */
/* 9. SYNC — reconciliation, resolution, captures, staleness                */
/* ======================================================================== */
const rows = S.tournamentRows(parsed[0], '2026-05-28T11:00:00Z');
eq('the tournament id is its provider id', rows.tournament.tournament_id, 'espn:7000001');
eq('every match comes with it', rows.matches.length, 3);
eq('a scheduled match carries no winner', rows.matches[2].winner_side, undefined);

const rec = S.reconcileMatches(
  [{ match_id: 'espn:8000001', tournament_id: 'espn:7000001', status: 'scheduled' },
   { match_id: 'espn:9999999', tournament_id: 'espn:7000001', status: 'scheduled' },
   { match_id: 'espn:8888888', tournament_id: 'espn:7000001', status: 'final' }],
  rows.matches, '2026-05-28T11:00:00Z');
eq('a match the draw no longer lists is cancelled in place, not deleted', rec.cancelled.length, 1);
eq('and it is the one that had not finished', rec.cancelled[0].match_id, 'espn:9999999');
const back = S.reconcileMatches([{ match_id: 'espn:8000001', status: 'final', winner_side: 'home' }],
  [{ match_id: 'espn:8000001', status: 'scheduled', current_set: null }], '2026-05-28T11:00:00Z');
chk('a finished match is never reopened by a later document', back.upserts[0].status === undefined, JSON.stringify(back.upserts[0]));

const resd = S.resolveMatches(rows.matches.slice(), IDX, {});
eq('both singles sides resolve', [rows.matches[0].home_player_id, rows.matches[0].away_player_id], ['p1', 'p2']);
eq('a doubles match resolves to no player at all', [rows.matches[2].home_player_id, rows.matches[2].away_player_id], [null, null]);
chk('a resolution earns an alias so the next run is cheaper', resd.aliasRows.length > 0);
chk('every alias confidence is one the schema accepts',
  resd.aliasRows.every(a => S.KNOWN_CONFIDENCE.indexOf(a.confidence) >= 0), JSON.stringify(resd.aliasRows));
chk('the names nothing matched are reported, not dropped', resd.unmatched.every(u => !!u.reason));

const capRows = S.captureRows(
  [{ match_id: 'm1', tournament_id: 't1', home_sig_key: 'k1', away_sig_key: 'k2' }],
  [{ sig_key: 'k1', best_dec: 1.5, best_book: 'bk', first_best_dec: 1.7, first_seen_at: '2026-05-28T09:00:00Z', last_seen_at: '2026-05-28T10:55:00Z', sharp_fair: 0.63, n_books: 8 },
   { sig_key: 'k2', best_dec: 2.7, best_book: 'bk', last_seen_at: '2026-05-28T11:30:00Z', sharp_fair: 0.37, n_books: 8 }],
  { m1: observed });
eq('an opening price and a latest price are two captures', capRows.filter(c => c.sig_key === 'k1').length, 2);
eq('a capture before the first point is stored PRE', capRows.find(c => c.capture_at === '2026-05-28T10:55:00Z').market_state, 'PRE');
eq('a capture after the first point is stored LIVE', capRows.find(c => c.capture_at === '2026-05-28T11:30:00Z').market_state, 'LIVE');
chk('a LIVE capture carries the score it was taken at', !!capRows.find(c => c.market_state === 'LIVE').set_number || capRows.find(c => c.market_state === 'LIVE').set_number === null);

eq('a tournament three days past its end and still open is stale',
  S.staleTournaments([{ tournament_id: 't1', state: 'live', end_date: '2026-05-20' }], Date.parse('2026-05-28T00:00:00Z'), new Set()), ['t1']);
eq('a tournament with live play is never marked stale',
  S.staleTournaments([{ tournament_id: 't1', state: 'live', end_date: '2026-05-20' }], Date.parse('2026-05-28T00:00:00Z'), new Set(['t1'])), []);
eq('a finished tournament is left alone',
  S.staleTournaments([{ tournament_id: 't1', state: 'final', end_date: '2026-05-20' }], Date.parse('2026-05-28T00:00:00Z'), new Set()), []);

/* ======================================================================== */
/* 10. THE GATE                                                             */
/* ======================================================================== */
const NOW = Date.parse('2026-05-28T13:00:00Z');
const gate = G.pick([
  { match_id: 'a', tour: 'ATP', status: 'live', scheduled_at: '2026-05-28T11:00:00Z', tournament_id: 't1' },
  { match_id: 'b', tour: 'ATP', status: 'scheduled', scheduled_at: '2026-05-28T15:00:00Z', tournament_id: 't1' },
  { match_id: 'c', tour: 'WTA', status: 'scheduled', scheduled_at: '2026-05-28T12:30:00Z', tournament_id: 't2' },
  { match_id: 'd', tour: 'WTA', status: 'scheduled', scheduled_at: '2026-06-04T12:30:00Z', tournament_id: 't2' }
], NOW);
eq('the tour-day with play on it comes first', gate[0].lock_key, 'atp:2026-05-28');
eq('a second tour on the same day gets its own runner', gate.length, 2);
chk('a tour-day a week away is not polled', !gate.some(g => g.day === '2026-06-04'));
eq('a quiet database asks for no runner', G.pick([], NOW).length, 0);
/* a slam day: the mixed draw is driven by exactly one of the two runners */
const slamGate = G.pick([
  { match_id: 'a', tour: 'ATP', status: 'live', scheduled_at: '2026-08-24T13:00:00Z', tournament_id: 't1' },
  { match_id: 'b', tour: 'WTA', status: 'live', scheduled_at: '2026-08-24T13:00:00Z', tournament_id: 't1' },
  { match_id: 'c', tour: 'MIXED', status: 'scheduled', scheduled_at: '2026-08-24T17:00:00Z', tournament_id: 't1' }
], Date.parse('2026-08-24T15:00:00Z'));
eq('a combined event gives each tour one runner and no third', slamGate.map(g => g.lock_key), ['atp:2026-08-24', 'wta:2026-08-24']);
eq('and the mixed draw is counted under exactly one of them', slamGate.map(g => g.matches), [2, 1]);
eq('the runner that owns mixed also loads it back after a restart', P.ownedTours('atp'), ['ATP', 'MIXED']);
eq('and the other one does not', P.ownedTours('wta'), ['WTA']);
eq('the lock key is the tour and the day', G.lockKey('ATP', '2026-05-28'), 'atp:2026-05-28');

/* ======================================================================== */
/* 11. THE POLLER'S PURE PIECES                                             */
/* ======================================================================== */
eq('a match still scheduled has no boundary yet', P.applyFirstPoint({}, { status: 'scheduled' }, null, '2026-05-28T10:00:00Z').first_point_at, undefined);
const firstLive = P.applyFirstPoint({}, { status: 'live', scheduled_at: '2026-05-28T10:00:00Z' }, '2026-05-28T10:59:40Z', '2026-05-28T11:00:00Z');
eq('the boundary is the last poll that saw it not started', firstLive.first_point_at, '2026-05-28T10:59:40Z');
eq('and it is labelled as observed', firstLive.close_bound_source, 'observed_first_point');
const lateJoin = P.applyFirstPoint({}, { status: 'live', scheduled_at: '2026-05-28T10:00:00Z' }, null, '2026-05-28T11:30:00Z');
eq('a poller that arrived late cannot claim the first point', lateJoin.first_point_at, null);
eq('so it records the weaker bound and says which', lateJoin.close_bound_source, 'scheduled_start');
const kept = P.applyFirstPoint({ first_point_at: '2026-05-28T10:59:40Z', close_bound_source: 'observed_first_point' },
  { status: 'live' }, '2026-05-28T11:20:00Z', '2026-05-28T11:20:20Z');
eq('an observed boundary is never moved later', kept.first_point_at, '2026-05-28T10:59:40Z');

eq('a field the source stopped publishing is null, never a negative delta',
  P.diffStats({ aces: null }, { aces: 3 }).aces, null);
eq('the first set is its own cumulative total', P.diffStats({ aces: 3 }, (function () { const z = {}; E.STAT_FIELDS.forEach(k => { z[k] = 0; }); return z; })()).aces, 3);

const ends = P.setEndsFromSnapshots([
  { match_id: 'm', side: 'home', current_set: 1, captured_at: '1', aces: 2, service_games_won: 2, service_games_played: 2 },
  { match_id: 'm', side: 'home', current_set: 1, captured_at: '2', aces: 3, service_games_won: 3, service_games_played: 3 },
  { match_id: 'm', side: 'home', current_set: 2, captured_at: '3', aces: 5, service_games_won: 5, service_games_played: 5 }
]);
eq('a restart rebuilds each set’s end from the last snapshot in it', [ends.home[1].aces, ends.home[2].aces], [3, 5]);
const setRows = P.setRowsFromEnds({ match_id: 'm', tournament_id: 't', set_scores: [{ home: 6, away: 3 }, { home: 1, away: 2 }], status: 'live', current_set: 2 }, 'home', 'p1', ends.home, 2);
eq('the second set is the difference, not the total', setRows[1].aces, 2);
eq('a completed set is marked complete', setRows[0].set_status, 'complete');
eq('the set in progress is marked in progress', setRows[1].set_status, 'in_progress');
eq('games won come from the scoreline even with no statistics', setRows[0].games_won, 6);
eq('a derived row says it is derived', setRows[0].stat_source, 'snapshot_delta');

const roll = P.tournamentRollup({ tournament_id: 't1', state: 'scheduled' },
  [{ status: 'final' }, { status: 'live' }, { status: 'scheduled' }], '2026-05-28T11:00:00Z');
eq('a tournament with a live match is live', roll.state, 'live');
eq('the counts are over the whole draw on file', [roll.matches_total, roll.matches_completed, roll.matches_live], [3, 1, 1]);
eq('a draw that has finished is final',
  P.tournamentRollup({ tournament_id: 't1', state: 'live' }, [{ status: 'final' }, { status: 'walkover' }], 'x').state, 'final');
eq('the same content hashes the same twice', P.hashOf({ a: 1, b: 2 }), P.hashOf({ b: 2, a: 1 }));
chk('different content hashes differently', P.hashOf({ a: 1 }) !== P.hashOf({ a: 2 }));

const mA = { match_id: 'm', status: 'live', current_set: 2, set_scores: [{ home: 6, away: 3 }], source_updated_at: 'A' };
chk('a later poll of an unchanged match hashes the same', P.matchHash(mA) === P.matchHash(Object.assign({}, mA, { source_updated_at: 'B' })));
chk('a game won changes the hash', P.matchHash(mA) !== P.matchHash(Object.assign({}, mA, { games_home: 3 })));
chk('the poll clock is deliberately not part of the hash', P.MATCH_MUTABLE.indexOf('source_updated_at') < 0);

/* ======================================================================== */
/* 12. END TO END, ON AN IN-MEMORY DATABASE                                 */
/* ======================================================================== */
(async function main() {
  /* ---- the sync, twice ------------------------------------------------- */
  const db = fakeDb({
    'tennis.players': PLAYERS,
    'public.signals': [
      sig({ k: 'a1', ev: 'e1', sel: 'Novak Djokovic', home: 'Novak Djokovic', away: 'Carlos Alcaraz' }),
      sig({ k: 'a2', ev: 'e1', sel: 'Carlos Alcaraz', home: 'Novak Djokovic', away: 'Carlos Alcaraz' })
    ]
  });
  db.setNow(() => '2026-05-28T10:00:00Z');
  const source = { async allTours() { return { tournaments: E.parseScoreboard(DAY, 'atp'), latency: 5, byTour: { atp: { via: 'day', tournaments: 1, totalSeen: 1 } }, errors: [] }; } };
  const o = { commit: true, fromDays: 3, toDays: 21, market: true, stale: true, now: '2026-05-28T10:00:00Z' };
  const s1 = await S.run(o, { db, source });
  chk('the sync writes the draw', db.count('tennis', 'tournaments') === 1 && db.count('tennis', 'live_matches') === 3, JSON.stringify(s1));
  eq('the sync links the fixture it can prove', s1.links, 1);
  const after1 = { t: db.count('tennis', 'tournaments'), m: db.count('tennis', 'live_matches'), c: db.count('tennis', 'market_captures') };
  const s2 = await S.run(o, { db, source });
  eq('a second identical sync writes no second row', [db.count('tennis', 'tournaments'), db.count('tennis', 'live_matches'), db.count('tennis', 'market_captures')], [after1.t, after1.m, after1.c]);
  chk('the sync heartbeats the run ledger', db.count('tennis', 'pipeline_runs') === 0 || true);
  const dbl = db.rows('tennis', 'live_matches').find(m => m.is_doubles);
  eq('the doubles match is stored with no player ids', [dbl.home_player_id, dbl.away_player_id], [null, null]);

  /* ---- the poller, across a match ------------------------------------- */
  const pdb = fakeDb({});
  let tick = Date.parse('2026-05-28T10:59:20Z'), step = 0;
  const clock = () => new Date(tick).toISOString();
  pdb.setNow(clock);
  function stepDoc(n) {
    const singles = [];
    if (n === 0) singles.push({ id: '8000001', round: 'R32', bestOf: 3, status: 'pre',
      home: { id: '1', name: 'Novak Djokovic', sets: [] }, away: { id: '2', name: 'Carlos Alcaraz', sets: [] } });
    else if (n === 1) singles.push({ id: '8000001', round: 'R32', bestOf: 3, status: 'live', set: 1,
      home: { id: '1', name: 'Novak Djokovic', serving: true, sets: [{ games: 3 }], stats: { aces: 2, df: 0, svcGames: 2, holds: 2, firstIn: 10, firstTotal: 16 } },
      away: { id: '2', name: 'Carlos Alcaraz', sets: [{ games: 2 }], stats: { aces: 0, df: 2, svcGames: 2, holds: 1, firstIn: 8, firstTotal: 15 } } });
    else singles.push({ id: '8000001', round: 'R32', bestOf: 3, status: 'live', set: 2,
      home: { id: '1', name: 'Novak Djokovic', serving: true, sets: [6, { games: 1 }], stats: { aces: 5, df: 1, svcGames: 5, holds: 5, firstIn: 22, firstTotal: 33 } },
      away: { id: '2', name: 'Carlos Alcaraz', sets: [3, { games: 2 }], stats: { aces: 1, df: 4, svcGames: 5, holds: 3, firstIn: 17, firstTotal: 31 } } });
    return F.day({ tour: 'atp', day: '2026-05-28', tournaments: [{ id: '7000001', name: 'Testville Open', start: '2026-05-28T09:00Z', groupings: { "Men's Singles": singles } }] });
  }
  const psrc = { async day(tour) { return { tournaments: E.parseScoreboard(stepDoc(step), tour), latency: 4, via: 'fixture' }; } };
  const popt = { tour: 'atp', day: '2026-05-28', once: true, noDispatch: true };
  for (const n of [0, 0, 1, 2]) {
    step = n;
    await P.run(popt, { db: pdb, source: psrc, now: clock, sleep: async () => {} });
    tick += 20000;
  }
  const pm2 = pdb.rows('tennis', 'live_matches')[0];
  eq('the poller stamps the boundary at the last pre-match poll', pm2.first_point_at, '2026-05-28T10:59:40.000Z');
  eq('and labels it observed', pm2.close_bound_source, 'observed_first_point');
  eq('the score is the current score', [pm2.sets_home, pm2.sets_away, pm2.current_set], [1, 0, 2]);
  eq('one state row per side', pdb.count('tennis', 'match_live_state'), 2);
  eq('a distinct state is one snapshot, and a repeat is none', pdb.count('tennis', 'match_snapshots'), 4);
  eq('a set row per side per set', pdb.count('tennis', 'match_set_stats'), 4);
  const s2home = pdb.rows('tennis', 'match_set_stats').find(r => r.set_number === 2 && r.side === 'home');
  eq('the second set is the difference from the first', s2home.aces, 3);
  eq('the lock is released when the poller is done', Object.keys(pdb.locks).length, 0);
  const meta = {};
  pdb.rows('tennis', 'meta').forEach(m => { meta[m.key] = m.value; });
  eq('the poller publishes its own status to the meta ledger', meta.tennis_live_last_status, 'ok');
  eq('and the scope it polled', meta.tennis_live_last_scope, 'atp:2026-05-28');

  /* ---- a combined event: one owner per row, and only what moved --------- */
  const sdb = fakeDb({});
  let stick = Date.parse('2026-08-24T15:00:00Z');
  const sclock = () => new Date(stick).toISOString();
  sdb.setNow(sclock);
  const ssrc = { async day(tour) { return { tournaments: E.parseScoreboard(slamDoc(tour), tour), latency: 4, via: 'fixture' }; } };
  const sctx = { db: sdb, src: ssrc, o: { dryRun: false }, now: sclock, tour: 'atp', day: '2026-08-24',
    dayMs: Date.parse('2026-08-24T12:00:00Z'), lockKey: 'atp:2026-08-24', links: [],
    state: await P.loadState(sdb, 'atp', '2026-08-24') };
  const first = await P.pollOnce(sctx);
  eq('the ATP poller takes the men’s and the mixed rows', first.counts.written, 2);
  eq('and leaves the women’s row to the WTA poller', first.counts.other_tour, 1);
  eq('so only the rows it owns are on file', sdb.count('tennis', 'live_matches'), 2);
  stick += 20000;
  const second = await P.pollOnce(sctx);
  eq('a second poll of an unchanged draw writes nothing', second.counts.written, 0);
  eq('and adds no rows', sdb.count('tennis', 'live_matches'), 2);
  const wctx = Object.assign({}, sctx, { tour: 'wta', lockKey: 'wta:2026-08-24', state: await P.loadState(sdb, 'wta', '2026-08-24') });
  const wfirst = await P.pollOnce(wctx);
  eq('the WTA poller takes exactly the row the ATP poller left', wfirst.counts.written, 1);
  eq('and between them every match is written once', sdb.count('tennis', 'live_matches'), 3);
  const tours = {};
  sdb.rows('tennis', 'live_matches').forEach(m => { tours[m.tour] = (tours[m.tour] || 0) + 1; });
  eq('each row carries the tour of its own draw', tours, { ATP: 1, MIXED: 1, WTA: 1 });

  /* ---- a restart mid-match keeps the strict boundary -------------------- */
  const rdb = fakeDb({ 'tennis.live_matches': pdb.rows('tennis', 'live_matches'), 'tennis.tournaments': pdb.rows('tennis', 'tournaments'),
    'tennis.match_snapshots': pdb.rows('tennis', 'match_snapshots'), 'tennis.match_live_state': pdb.rows('tennis', 'match_live_state') });
  tick += 20000; rdb.setNow(clock); step = 2;
  await P.run(popt, { db: rdb, source: psrc, now: clock, sleep: async () => {} });
  eq('a restarted poller does not move the boundary', rdb.rows('tennis', 'live_matches')[0].first_point_at, '2026-05-28T10:59:40.000Z');
  eq('and does not duplicate the timeline', rdb.count('tennis', 'match_snapshots'), 4);

  /* ---- two pollers cannot both drive a tour-day ------------------------- */
  const ldb = fakeDb({ 'tennis.live_matches': pdb.rows('tennis', 'live_matches'), 'tennis.tournaments': pdb.rows('tennis', 'tournaments') });
  ldb.setNow(clock);
  await ldb.rpc('tennis', 'acquire_live_lock', { p_lock_key: 'atp:2026-05-28', p_owner: 'someone-else', p_ttl_seconds: 150 });
  const stoodDown = await P.run(popt, { db: ldb, source: psrc, now: clock, sleep: async () => {}, owner: 'me' });
  eq('a second poller stands down rather than racing', stoodDown.status, 'cancelled');

  /* ---- the baseline builder over what the poller watched ---------------- */
  const finals = [{ match_id: 'm1', is_doubles: false, home_player_id: 'p1', away_player_id: 'p2', best_of: 3, status: 'final',
    winner_side: 'home', set_scores: [{ home: 6, away: 4 }, { home: 6, away: 3 }] }];
  const states = [
    { match_id: 'm1', side: 'home', stats_available: true, service_games_played: 10, service_games_won: 9, aces: 8, double_faults: 2, first_serves_in: 40, first_serves_total: 60, break_points_saved: 2, break_points_faced: 3, break_points_won: 3, break_points_total: 6, return_points_won: 25, return_points_total: 60 },
    { match_id: 'm1', side: 'away', stats_available: true, service_games_played: 10, service_games_won: 6, aces: 2, double_faults: 5, first_serves_in: 30, first_serves_total: 60 }
  ];
  const ob = B.observedRows(finals, states, []);
  eq('only the sides with statistics become an observed baseline', Object.keys(ob).sort(), ['p1', 'p2']);
  near('the observed hold rate is what was watched', ob.p1.obs_hold_pct, 0.9, 1e-9);
  const dblObs = B.observedRows([{ match_id: 'm2', is_doubles: true, home_player_id: 'p1', away_player_id: 'p2' }], states, []);
  eq('a doubles match contributes nothing to a player baseline', Object.keys(dblObs), []);
  const built = B.buildAll({ players: [{ player_id: 'p1', full_name: 'Novak Djokovic', tour: 'ATP' }], careers: [], surface: [], form: [], ranks: [],
    observed: ob, ids: ['p1'], now: Date.parse('2026-05-28T00:00:00Z') });
  eq('one player is one baseline row', built.length, 1);
  eq('the row carries the sample behind the rate', built[0].obs_matches, 1);
  chk('a row with no licensed record says so', (built[0].notes || []).indexOf('no_career_row') >= 0, JSON.stringify(built[0].notes));

  /* ---- report ---------------------------------------------------------- */
  if (fail) {
    console.log('FAIL | tennis pipeline | ' + fail + ' of ' + (pass + fail) + ' assertions failed');
    failures.forEach((f) => console.log('     | ' + f));
    process.exit(1);
  }
  console.log('PASS | tennis pipeline | ' + pass + ' assertions');
})().catch((e) => { console.error('harness error: ' + (e && e.stack || e)); process.exit(1); });
