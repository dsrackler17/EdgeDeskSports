#!/usr/bin/env node
/* ===========================================================================
   Market, identity and betting-integrity rules (football/cfb_lab/integrity.js,
   football/cfb_lab/identity.js; docs/cfb-production/MARKET_INTEGRITY.md and
   IDENTITY.md). Known answers only:

   - market normalization: every shared case in fixtures/integrity_rules.json
     (+450 spread, odds of 0, identical side prices, a future timestamp ...);
   - wrong game: teams, orientation, kickoff; "Miami" is never "Miami (OH)";
   - outlier quarantine: MAD cross-book outlier, 1-2 book disagreement, sign
     flip, uncorroborated jump, spread-vs-moneyline favourite; corroborated
     moves are NOT flagged;
   - consensus integrity and true freshness (provider_updated_at), stale
     share, unresolved disagreement, outliers isolated;
   - settlement validity (final state + valid score), reschedule voiding;
   - the extreme-disagreement / extreme-probability review and the fail-closed
     BET gate; the BET-volume guard flags and never cancels;
   - team / game identity master: provider ids, aliases, conflicts,
     validation (unmapped, same team, season context), duplicates in either
     orientation, the lab's team-mapping check.

   Run: node football/cfb_lab/integrity.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const I = require('./integrity.js');
const ID = require('./identity.js');
const M = require('./models.js');

let pass = 0, fail = 0; const fails = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; fails.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); } }
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'integrity_rules.json'), 'utf8'));
const NOW = '2026-10-01T12:00:00.000Z';
const at = (min) => new Date(Date.parse(NOW) + min * 60000).toISOString();
const sq = (o) => Object.assign({ quote_id: 'q' + Math.random().toString(36).slice(2, 8), source: 'odds_api', book: 'dk', game_id: 'g1', market_type: 'spread', home_line: -3.5, price_home: -110, price_away: -110,
  observed_at: at(-30), is_pregame: true, is_provider_open: false, is_provider_close: false }, o);

/* ═══ 1. market normalization (the shared cases) ═══════════════════════ */
{
  const mism = FIX.quote_cases.filter((c) => JSON.stringify(I.validateQuote(c.quote, { now: FIX.now }).reasons.slice().sort()) !== JSON.stringify(c.expected.slice().sort()));
  chk('validateQuote reproduces every shared case (' + FIX.quote_cases.length + ')', mism.length === 0, mism.map((c) => c.why));
  const v = I.validateQuote(sq({ home_line: 450 }), { now: NOW });
  chk('a +450 spread is REJECT, never a market', !v.ok && v.severity === 'REJECT' && v.reasons.includes('SPREAD_OUT_OF_BOUNDS'));
  chk('American odds of 0 are REJECT', I.validateQuote(sq({ market_type: 'moneyline', price_home: 0, price_away: -150 }), { now: NOW }).reasons.includes('PRICE_ZERO'));
  chk('a missing field stays missing: num(null) / num("") / num(true) are null, num(0) is 0', I.num(null) === null && I.num('') === null && I.num(true) === null && I.num(0) === 0 && I.num('-3.5') === -3.5);
}

/* ═══ 2. wrong game ═════════════════════════════════════════════════════ */
{
  const same = ID.sameTeamFn();
  const game = { home: 'Texas', away: 'Oklahoma', kickoff: '2026-10-10T16:00:00.000Z' };
  const q = (o) => sq(Object.assign({ home_team: 'Texas Longhorns', away_team: 'Oklahoma Sooners', kickoff_ts: '2026-10-10T16:00:00.000Z' }, o));
  chk('the right game passes (book nicknames resolve: "Texas Longhorns" is Texas)', I.validateQuote(q({}), { now: NOW, game, sameTeam: same }).ok);
  chk('a swapped orientation is WRONG_GAME_ORIENTATION', I.validateQuote(q({ home_team: 'Oklahoma Sooners', away_team: 'Texas Longhorns' }), { now: NOW, game, sameTeam: same }).reasons.includes('WRONG_GAME_ORIENTATION'));
  chk('another game entirely is WRONG_GAME_TEAMS', I.validateQuote(q({ home_team: 'Ohio State Buckeyes', away_team: 'Michigan Wolverines' }), { now: NOW, game, sameTeam: same }).reasons.includes('WRONG_GAME_TEAMS'));
  chk('Miami (FL) is never Miami (OH): WRONG_GAME_TEAMS', I.validateQuote(q({ home_team: 'Miami (OH) RedHawks', away_team: 'Oklahoma Sooners' }), { now: NOW, game: { home: 'Miami', away: 'Oklahoma' }, sameTeam: same }).reasons.includes('WRONG_GAME_TEAMS'));
  chk('a kickoff 3 days away is WRONG_GAME_KICKOFF (another week\'s game)', I.validateQuote(q({ kickoff_ts: '2026-10-13T16:00:00.000Z' }), { now: NOW, game, sameTeam: same }).reasons.includes('WRONG_GAME_KICKOFF'));
  const u = I.validateQuote(q({ home_team: 'Nowhere Tech', away_team: 'Oklahoma Sooners' }), { now: NOW, game: { home: 'Somewhere Tech', away: 'Oklahoma' }, sameTeam: same });
  chk('an unresolvable name is not guessed: it is a TEAM_UNVERIFIED warning, not a match', u.warnings.includes('TEAM_UNVERIFIED'));
  chk('without a resolver there is no substring match ("Miami" vs "Miami (OH)" cannot tell)', I.defaultSameTeam('Miami', 'Miami (OH)') === null && I.defaultSameTeam('Texas', 'texas') === true);
}

/* ═══ 3. outlier quarantine ═════════════════════════════════════════════ */
{
  const peers = [sq({ book: 'a', home_line: -3 }), sq({ book: 'b', home_line: -3.5 }), sq({ book: 'c', home_line: -3 }), sq({ book: 'd', home_line: -3.5 })];
  const o = I.screenQuote(sq({ book: 'x', home_line: -10, observed_at: at(-5) }), peers, null);
  chk('MAD: one book at -10 against four at -3/-3.5 is a CROSS_BOOK_OUTLIER (quarantined)', !o.ok && o.severity === 'QUARANTINE' && o.reasons.includes('CROSS_BOOK_OUTLIER') && o.evidence.peer_median === -3.25, o);
  chk('a normal half-point difference is not an outlier', I.screenQuote(sq({ book: 'x', home_line: -4, observed_at: at(-5) }), peers, null).ok);
  chk('peers older than the 6 h window are not used', I.screenQuote(sq({ book: 'x', home_line: -10, observed_at: at(10 * 60) }), peers, null).ok);
  const two = [sq({ book: 'a', home_line: -3 }), sq({ book: 'b', home_line: -3 })];
  chk('with two peers, a 9-point disagreement is CROSS_BOOK_DISAGREEMENT', I.screenQuote(sq({ book: 'x', home_line: -12, observed_at: at(-5) }), two, null).reasons.includes('CROSS_BOOK_DISAGREEMENT'));
  chk('a sign flip of the same book (-7 then +7) with no one else moving is SIGN_FLIP_SUSPECT',
    I.screenQuote(sq({ home_line: 7, observed_at: at(-5) }), [], sq({ home_line: -7, observed_at: at(-60) })).reasons.includes('SIGN_FLIP_SUSPECT'));
  chk('the same flip corroborated by other books is a real move (not flagged)',
    I.screenQuote(sq({ home_line: 7, observed_at: at(-5) }), [sq({ book: 'b', home_line: 6.5, observed_at: at(-10) })], sq({ home_line: -7, observed_at: at(-60) })).ok);
  chk('an uncorroborated 11-point jump is UNCORROBORATED_JUMP', I.screenQuote(sq({ home_line: -14, observed_at: at(-5) }), [], sq({ home_line: -3, observed_at: at(-60) })).reasons.includes('UNCORROBORATED_JUMP'));
  chk('a 4-point QB-news move is not flagged', I.screenQuote(sq({ home_line: -7, observed_at: at(-5) }), [], sq({ home_line: -3, observed_at: at(-60) })).ok);
  const tp = [55, 55.5, 56, 55].map((x, i) => sq({ book: 'b' + i, market_type: 'total', home_line: null, total_points: x }));
  chk('totals: a 70 against 55-56 is an outlier; 57.5 is not', I.screenQuote(sq({ book: 'x', market_type: 'total', home_line: null, total_points: 70, observed_at: at(-5) }), tp, null).reasons.includes('CROSS_BOOK_OUTLIER')
    && I.screenQuote(sq({ book: 'x', market_type: 'total', home_line: null, total_points: 57.5, observed_at: at(-5) }), tp, null).ok);
  chk('provider-declared openers/closes are not screened', I.screenQuote(sq({ home_line: -30, is_provider_open: true }), peers, null).ok);
  chk('one book, one moment: spread home -7 with a moneyline that makes the away team favourite is CROSS_MARKET_ORIENTATION',
    I.crossMarket(sq({ home_line: -7 }), sq({ market_type: 'moneyline', price_home: 220, price_away: -270 })).includes('CROSS_MARKET_ORIENTATION')
    && I.crossMarket(sq({ home_line: -7 }), sq({ market_type: 'moneyline', price_home: -270, price_away: 220 })).length === 0
    && I.crossMarket(sq({ home_line: -1 }), sq({ market_type: 'moneyline', price_home: 105, price_away: -125 })).length === 0);
}

/* ═══ 4. consensus integrity and true freshness ═════════════════════════ */
{
  const K = at(20 * 60);
  const A = (qs, o) => I.assessMarket(qs, NOW, Object.assign({ kickoff: K }, o));
  chk('no quote: MISSING / MARKET_MISSING', A([]).status === 'MISSING' && A([]).actionable_status === 'MARKET_MISSING');
  const one = A([sq({})]);
  chk('one book is not a consensus: DEGRADED / MARKET_DEGRADED', one.status === 'DEGRADED' && one.actionable_status === 'MARKET_DEGRADED' && one.n_books === 1, one);
  const two = A([sq({ book: 'a' }), sq({ book: 'b', home_line: -3 })]);
  chk('two fresh agreeing books: OK / ACTIONABLE', two.status === 'OK' && two.actionable_status === 'ACTIONABLE' && two.bet_fresh === true, two);
  const staleProv = A([sq({ book: 'a', provider_updated_at: at(-10 * 60) }), sq({ book: 'b', provider_updated_at: at(-9 * 60) })]);
  chk('a heartbeat of a book that stopped updating is stale: provider_updated_at 9 h old -> MARKET_STALE', staleProv.actionable_status === 'MARKET_STALE' && staleProv.newest_true_age_h === 9, staleProv);
  const betStale = A([sq({ book: 'a', observed_at: at(-4 * 60) }), sq({ book: 'b', observed_at: at(-4 * 60) })]);
  chk('4 h old quotes are fresh for display (6 h) but not for a BET (3 h): MARKET_STALE for betting', betStale.status === 'OK' && betStale.actionable_status === 'MARKET_STALE' && betStale.bet_fresh === false, betStale);
  const fut = A([sq({ book: 'a' }), sq({ book: 'b', observed_at: at(2) })]);
  chk('a quote observed after the decision time is not in the market at all', fut.n_books === 1);
  const inv = I.assessMarket([sq({ book: 'a', home_line: 450 }), sq({ book: 'b' })], NOW, { kickoff: K });
  chk('an impossible quote in the market: INVALID / MARKET_INVALID', inv.status === 'INVALID' && inv.actionable_status === 'MARKET_INVALID');
  const q1 = sq({ book: 'a' });
  chk('a quarantined quote in the market: INVALID', I.assessMarket([q1, sq({ book: 'b' })], NOW, { kickoff: K, quarantinedIds: { [q1.quote_id]: true } }).status === 'INVALID');
  const wide = A([sq({ book: 'a', home_line: -3 }), sq({ book: 'b', home_line: -8 })]);
  chk('two books 5 points apart cannot be resolved: DEGRADED (unresolved disagreement)', wide.status === 'DEGRADED' && /unresolved/.test(wide.reasons.join()), wide);
  const iso = A([sq({ book: 'a', home_line: -3 }), sq({ book: 'b', home_line: -3.5 }), sq({ book: 'c', home_line: -3 }), sq({ book: 'd', home_line: -12 })]);
  chk('with four books one outlier is isolated (never actionable) and the rest stays OK', iso.status === 'OK' && iso.outlier_quote_ids.length === 1 && iso.quarantined_quote_ids.length === 1 && iso.range_pts === 0.5, iso);
  const halfStale = A([sq({ book: 'a' }), sq({ book: 'b', provider_updated_at: at(-10 * 60) }), sq({ book: 'c', provider_updated_at: at(-10 * 60) })]);
  chk('two of three books stale: DEGRADED (stale share > 50%)', halfStale.status === 'DEGRADED' && halfStale.stale_share === 0.667, halfStale);
  chk('freshness: odds 7 h old with 30 h to go is STALE (6 h limit); with 60 h to go FRESH (36 h)',
    I.freshnessOf('odds', at(-7 * 60), NOW, 30).status === 'STALE' && I.freshnessOf('odds', at(-7 * 60), NOW, 60).status === 'FRESH');
  chk('freshness: a timestamp from the future is a CLOCK_FAULT, not fresh', I.freshnessOf('odds', at(60), NOW, 30).status === 'CLOCK_FAULT');
  chk('freshness: a missing timestamp is MISSING; weather is OPTIONAL', I.freshnessOf('qb', null, NOW).status === 'MISSING' && I.FRESHNESS.weather.importance === 'OPTIONAL');
}

/* ═══ 5. settlement validity ══════════════════════════════════════════════ */
{
  const F = (o) => Object.assign({ status: 'FINAL', home_points: 31, away_points: 24 }, o);
  chk('a real final is valid', I.finalProblem(F({})) === null);
  chk('an overtime final (45-38) is valid', I.finalProblem(F({ home_points: 45, away_points: 38, overtime: true })) === null);
  chk('a tied "final" is refused (no ties in college football)', /tied/.test(I.finalProblem(F({ home_points: 0, away_points: 0 }))));
  chk('a final without scores is refused', /both scores/.test(I.finalProblem(F({ home_points: null }))));
  chk('a negative, huge or fractional score is refused', /0-150/.test(I.finalProblem(F({ home_points: -3 }))) && /0-150/.test(I.finalProblem(F({ home_points: 222 }))) && /non-integer/.test(I.finalProblem(F({ home_points: 30.5 }))));
  chk('a suspended game is not a final state even if completed', /not a final state/.test(I.finalProblem(F({ name: 'STATUS_SUSPENDED' }))));
  chk('a game played 5 days after the snapshot\'s kickoff was rescheduled; 3 hours later was not', I.rescheduled('2026-10-03T19:30:00Z', '2026-10-08T19:30:00Z') && !I.rescheduled('2026-10-03T19:30:00Z', '2026-10-03T22:30:00Z'));
}

/* ═══ 6. extreme review + BET gate + BET volume ═════════════════════════ */
{
  const X = (o) => Object.assign({ pure_home_margin: 17, fair_spread_home_line: -17, market_home_line: -3, side: 'HOME', cover_probability: 0.56, home_id: 'h', away_id: 'a',
    game_id: 'g1', qb_certainty: 100, injury_certainty: 100, feature_ts: at(-24 * 60), market_age_min: 20, now: NOW, market_integrity: { status: 'OK' }, model_version: 'm', params_hash: 'p' }, o);
  const ok = I.extremeReview(X({}));
  chk('a 14-point model-market gap triggers the review, and a clean case passes it', ok.required && ok.triggers.includes('EXTREME_GAP') && ok.ok, ok);
  chk('the review is not required for an ordinary gap and probability', !I.extremeReview(X({ pure_home_margin: 5, fair_spread_home_line: -5 })).required);
  chk('a historically unobserved cover probability (0.63) triggers it (diagnostic, not a cap)', I.extremeReview(X({ pure_home_margin: 5, fair_spread_home_line: -5, cover_probability: 0.63 })).triggers.join() === 'EXTREME_COVER_PROBABILITY');
  const f = (o) => I.extremeReview(X(o)).failures.join(' | ');
  chk('sign: a stored fair line that is not -margin fails', /SIGN: fair_spread_home_line/.test(f({ fair_spread_home_line: 17 })));
  chk('sign: a side that is not where the gap points fails', /SIGN: the side/.test(f({ side: 'AWAY' })));
  chk('sign: a market that looks flipped fails (model +20, market home +21.5 => flipped -21.5 reconciles)', /looks flipped/.test(f({ pure_home_margin: 20, fair_spread_home_line: -20, market_home_line: 21.5 })));
  chk('mapping: the same team at home and away fails', /MAPPING: home and away/.test(f({ away_id: 'h' })));
  chk('mapping: a quote from another game fails', /MAPPING: the quote belongs/.test(f({ quote_game_id: 'g2' })));
  chk('QB: an unconfirmed starter fails', /QB/.test(f({ qb_certainty: 40 })));
  chk('injuries: no availability report fails', /INJURY/.test(f({ injury_certainty: 30 })));
  chk('features: football inputs 9 days old fail', /FEATURES/.test(f({ feature_ts: at(-9 * 24 * 60) })));
  chk('market: a 2-hour-old quote fails; a degraded consensus fails', /MARKET: the quote/.test(f({ market_age_min: 120 })) && /MARKET: consensus DEGRADED/.test(f({ market_integrity: { status: 'DEGRADED' } })));
  chk('artifact: a params hash that is not the frozen one fails', /ARTIFACT/.test(f({ expected_params_hash: 'frozen', params_hash: 'drifted' })));
  const A = { status: 'OK', actionable_status: 'ACTIONABLE', reasons: [] };
  chk('BET stays BET only when the market is ACTIONABLE and the review passed', I.betGate('BET', A, ok).decision_class === 'BET');
  chk('fail closed: a stale market turns BET into PASS with the reason', I.betGate('BET', { actionable_status: 'MARKET_STALE', reasons: ['newest quote 7 h old'] }, null).decision_class === 'PASS'
    && /MARKET_STALE/.test(I.betGate('BET', { actionable_status: 'MARKET_STALE', reasons: [] }, null).reason));
  chk('fail closed: no market verdict at all is not ACTIONABLE', I.betGate('BET', null, null).decision_class === 'PASS');
  chk('fail closed: a failed extreme review turns BET into PASS', I.betGate('BET', A, I.extremeReview(X({ qb_certainty: 20 }))).decision_class === 'PASS');
  chk('the gate never touches LEAN / PASS / RESEARCH', ['LEAN', 'PASS', 'RESEARCH'].every((c) => I.betGate(c, null, null).decision_class === c && !I.betGate(c, null, null).gated));
  const v = I.betVolume(31, [3, 4, 2, 5, 3]);
  chk('BET volume: 31 against a history median of 3 is flagged for review', v.flag && v.action === 'REVIEW' && v.limit === 10, v);
  chk('BET volume: 6 is not flagged; a flag never cancels', !I.betVolume(6, [3, 4, 2, 5, 3]).flag && /never cancels/.test(v.note));
  chk('BET volume without history: only an absurd count (> 20) flags', !I.betVolume(15, []).flag && I.betVolume(25, [1]).flag);
}

/* ═══ 7. team identity master ══════════════════════════════════════════ */
{
  const R = (x) => ID.resolveTeam(x).internal_team_id;
  chk('provider id -> internal id (ESPN 2390 = miami, 193 = miamioh)', R('2390') === 'miami' && R(193) === 'miamioh');
  chk('aliases and book names resolve: "Miami Hurricanes", "Miami RedHawks", "UMass Minutemen", "Pitt Panthers"',
    R('Miami Hurricanes') === 'miami' && R('Miami RedHawks') === 'miamioh' && R('UMass Minutemen') === 'massachusetts' && R('Pitt Panthers') === 'pittsburgh');
  chk('"Ohio" is never "Ohio State"; "Ohio Bobcats" is Ohio', R('Ohio') === 'ohio' && R('Ohio State Buckeyes') === 'ohiostate' && R('Ohio Bobcats') === 'ohio');
  const conflict = ID.resolveTeam({ id: '2390', name: 'Miami (OH)' });
  chk('an id and a name that disagree resolve to NOTHING (never guessed), and sameTeam is false', conflict.internal_team_id === null && conflict.conflict && ID.sameTeam({ id: '2390', name: 'Miami (OH)' }, 'Miami') === false);
  chk('an unknown name does not resolve', R('Home U') === null);
  const vg = (o) => ID.validateGame(Object.assign({ home_team: 'Texas', away_team: 'Oklahoma', home_id: '251', away_id: '201', season: 2026 }, o));
  chk('a valid game passes', vg({}).ok && vg({}).home === 'texas' && vg({}).away === 'oklahoma');
  chk('an unmapped team fails the game (HOME_UNMAPPED)', !vg({ home_team: 'Nowhere Tech', home_id: null }).ok && /HOME_UNMAPPED/.test(vg({ home_team: 'Nowhere Tech', home_id: null }).problems.join()));
  chk('identical teams fail (SAME_TEAM)', /SAME_TEAM/.test(vg({ away_team: 'Texas', away_id: '251' }).problems.join()));
  chk('identical ids fail even with different names (SAME_TEAM_ID)', /SAME_TEAM_ID/.test(vg({ away_id: '251' }).problems.join()));
  chk('conference context: a feed conference that disagrees with the master is a warning', /CONFERENCE/.test(vg({ home_conference: 'Big Ten' }).warnings.join()));
  const dups = ID.findDuplicates([
    { game_id: '401', home_team: 'Texas', away_team: 'Oklahoma', season: 2026, kickoff: '2026-10-10T16:00:00Z' },
    { game_id: 'oa_77', home_team: 'Texas Longhorns', away_team: 'Oklahoma Sooners', season: 2026, kickoff: '2026-10-10T16:30:00Z' },
    { game_id: 'x9', home_team: 'Oklahoma', away_team: 'Texas', season: 2026, kickoff: '2026-10-10T16:00:00Z' },
    { game_id: 'y1', home_team: 'Texas', away_team: 'Oklahoma', season: 2026, kickoff: '2026-11-20T16:00:00Z' }]);
  chk('duplicate games: the same matchup under two provider ids, and the swapped orientation, within 36 h',
    dups.some((d) => d.kind === 'SAME_ORIENTATION' && d.game_ids.join() === '401,oa_77') && dups.some((d) => d.kind === 'SWAPPED_ORIENTATION') && !dups.some((d) => d.game_ids.includes('y1')), dups);
  const gi = ID.gameIdentity({ game_id: 'oa_77', provider: 'odds_api', home_team: 'Texas Longhorns', away_team: 'Oklahoma Sooners', season: 2026, kickoff: '2026-10-10T16:30:00Z' });
  chk('game identity: canonical key plus the provider\'s own orientation, kept for debugging', gi.key === '2026|texas|oklahoma|2026-10-10' && gi.provider.home_team === 'Texas Longhorns' && gi.provider.source === 'odds_api', gi);
  chk('pair keys are canonical ("Miami (FL)" and "Miami" are one team)', ID.pairKey('Miami (FL)', 'Florida State') === ID.pairKey('Miami', 'Florida State'));
  /* the lab's data-quality team-mapping check through the master */
  const proj = (home, away, hid, aid) => ({ game: { home, away, home_id: hid, away_id: aid, kickoff: '2026-10-10T16:00:00Z' }, pure: { margin: 3, sigma: 15 } });
  const dq = (p, g) => M.dataQuality({ slateGame: g, model: p, market: null, hours: 30, now: NOW, dupPairs: new Map() }).checks.find((c) => c.check === 'team_mapping');
  chk('lab DQ: "Miami" against a schedule of "Miami (OH)" is RED (the substring match used to call it GREEN)', dq(proj('Miami', 'Ohio'), { home_team: 'Miami (OH)', away_team: 'Ohio', input_contract: [] }).status === 'RED');
  chk('lab DQ: provider id 166 against the board key newmexicostate is GREEN', dq(proj('New Mexico State', 'Western Kentucky', '166', '98'), { home_team: 'New Mexico State', away_team: 'Western Kentucky', home_team_id: 'newmexicostate', away_team_id: 'westernkentucky', input_contract: [] }).status === 'GREEN');
  chk('lab DQ: a swapped pair is RED', /swapped/.test(dq(proj('Texas', 'Oklahoma'), { home_team: 'Oklahoma', away_team: 'Texas', input_contract: [] }).detail || ''));
  chk('lab DQ: home and away the same team is RED', dq(proj('Texas', 'Texas', '251', '251'), null).status === 'RED');
  chk('lab DQ: unverifiable names that differ are RED (unknown mapping fails safely)', dq(proj('Nowhere Tech', 'Oklahoma'), { home_team: 'Somewhere Tech', away_team: 'Oklahoma', input_contract: [] }).status === 'RED');
}

fails.forEach((f) => console.log('FAIL | ' + f));
console.log((fail ? 'FAILED ' : 'ALL GREEN ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
