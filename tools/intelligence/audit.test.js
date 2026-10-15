#!/usr/bin/env node
/* ===========================================================================
   THE ADVERSARIAL AUDITOR (_audit.js, EDAUDIT) AND THE SPORT ADAPTERS
   (lib/edgedesk_sport_adapters.js, EDADAPT).

   Every assertion is about a recommendation that must NOT reach a customer as
   verified: a price that moved, a quote that predates a quarterback ruled out,
   a starting pitcher who was scratched, an edge that exists under one de-vig
   method only, one off-market book, an unexplained model disagreement, a
   contract that settles on regulation priced against a market that includes
   overtime, a calculation that does not reproduce — and a correction loop
   that must end.

   Run: node tools/intelligence/audit.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const FN = path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai');
require(path.join(FN, '_intelligence.js'));
const F = require(path.join(ROOT, 'lib', 'edgedesk_fairodds.js'));
const AD = require(path.join(ROOT, 'lib', 'edgedesk_sport_adapters.js'));
const AU = require(path.join(FN, '_audit.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function eq(name, a, b) { chk(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b }); }
function done() {
  failures.forEach((f) => console.log('FAIL | ' + f.name + '  ' + String(JSON.stringify(f.detail)).slice(0, 600)));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
const check = (a, id) => a.checks.find((c) => c.id === id) || {};

/* A fixed clock: Sunday 2026-10-11 22:00 UTC; first pitch 01:00 UTC (180 min out, a 45-min quote limit). */
const NOW = Date.parse('2026-10-11T22:00:00Z');
const KICK = '2026-10-12T01:00:00Z';
const T = (min) => new Date(NOW - min * 60000).toISOString();

/* Rays (away) at Guardians: Rays +120 (2.20) at FanDuel; Pinnacle 2.08 / 1.81 → sharp fair ≈ 0.4653 (Shin stored 0.4655) */
function candidate(over) {
  return Object.assign({
    id: 'baseball_mlb|g1|h2h|away', sport: 'baseball_mlb', sport_label: 'MLB', game_id: 'g1', matchup: 'Tampa Bay Rays @ Cleveland Guardians',
    home: 'Cleveland Guardians', away: 'Tampa Bay Rays', kickoff: KICK, market: 'h2h', side: 'away', selection: 'Tampa Bay Rays', line: null,
    quote: { book: 'fanduel', odds_american: 120, odds_decimal: 2.2, captured_at: T(5), freshness: 'CURRENT', actionable: true, executable: true },
    fair: { method: 'MARKET_DEVIG', probability: 0.4655, push_probability: null },
    edge: { ev_per_unit: Math.round((0.4655 * 1.2 - 0.5345) * 1e4) / 1e4, probability_edge_pp: 1.0 },
    starters: { home: 'Tanner Bibee', away: 'Shane Baz' }
  }, over || {});
}
function freshRow(over) {
  return Object.assign({ sig_key: 'e1|h2h|Tampa Bay Rays|', best_dec: 2.2, best_book: 'fanduel', sharp_fair: 0.4655, consensus_fair: 0.4640, pin_dec: 2.08, pin_opp_dec: 1.81, n_books: 6, last_seen_at: T(2) }, over || {});
}
const BOOKS = [{ book: 'fanduel', dec: 2.2 }, { book: 'draftkings', dec: 2.18 }, { book: 'betmgm', dec: 2.15 }, { book: 'caesars', dec: 2.12 }, { book: 'pinnacle', dec: 2.08 }];
const STARTERS = { home: { name: 'Tanner Bibee', source: 'mlb_game_cards', observed_at: T(1) }, away: { name: 'Shane Baz', source: 'mlb_game_cards', observed_at: T(1) } };
/* availability: the source was read for both teams (complete) 30 minutes ago and lists nobody */
function evidence(over) { return Object.assign({ fresh: freshRow(), books: BOOKS, availability: [], availability_complete: true, availability_as_of: T(30), starters_now: STARTERS }, over || {}); }

/* ═══ 1. SPORT ADAPTERS — capture, models, settlement ═══════════════════ */
{
  eq('NBA with no prices is NOT_CAPTURED, not an empty slate', AD.coverageStatus('basketball_nba', { signals: 0, games: 0 }).status, 'NOT_CAPTURED');
  chk('…and the reason says so', /not an empty slate/.test(AD.coverageStatus('basketball_nba', { signals: 0 }).why));
  eq('NHL that DOES have prices was captured (data wins over configuration)', AD.coverageStatus('icehockey_nhl', { signals: 12, games: 3 }).status, 'EVALUATED');
  eq('MLB (captured) with games and no prices is NO_PRICES', AD.coverageStatus('baseball_mlb', { signals: 0, games: 4 }).status, 'NO_PRICES');
  eq('MLB with nothing is NO_GAMES', AD.coverageStatus('baseball_mlb', { signals: 0, games: 0 }).status, 'NO_GAMES');
  eq('a read failure is RETRIEVAL_FAILED', AD.coverageStatus('baseball_mlb', { read_error: 'timeout' }).status, 'RETRIEVAL_FAILED');
  eq('soccer is NOT_SUPPORTED', AD.coverageStatus('soccer_epl', {}).status, 'NOT_SUPPORTED');
  eq('an explicit captured list overrides the defaults', AD.coverageStatus('basketball_nba', { signals: 0, games: 0, captured_list: 'basketball_nba,baseball_mlb' }).status, 'NO_GAMES');
  eq('capture defaults are NFL, CFB, MLB, UFC', AD.capturedSports().sort(), ['americanfootball_ncaaf', 'americanfootball_nfl', 'baseball_mlb', 'mma_mixed_martial_arts']);
  const nfl = AD.modelCapability('americanfootball_nfl', 'spreads');
  eq('NFL spread model may price (LEAN)', [nfl.independent_model, nfl.may_price, nfl.tier], [true, true, 'LEAN']);
  eq('NFL total model is research only', AD.modelCapability('americanfootball_nfl', 'totals').may_price, false);
  const mlb = AD.modelCapability('baseball_mlb', 'h2h');
  eq('MLB has a model, but it runs in the browser only and is RESEARCH: it may not price', [mlb.independent_model, mlb.may_price, mlb.tier], [true, false, 'RESEARCH']);
  chk('…and the reason says browser only', /browser only/.test(mlb.reason), mlb.reason);
  const nba = AD.modelCapability('basketball_nba', 'h2h');
  eq('NBA has an independent model (nba/slate.json) that the captured-price board does not price: it is outcome-validated, never tested against the close', [nba.independent_model, nba.may_price, nba.tier, /multi-sport desk/.test(nba.reason)], [true, false, 'OUTCOME_VALIDATED', true]);
  eq('NHL likewise: an independent model, compared by the multi-sport desk', [AD.modelCapability('icehockey_nhl', 'h2h').independent_model, AD.modelCapability('icehockey_nhl', 'h2h').may_price], [true, false]);
  chk('…its independent fair probability is unavailable, stated', /unavailable/.test(nba.reason), nba.reason);
  eq('UFC has no model (the market\'s de-vig only)', AD.modelCapability('mma_mixed_martial_arts', 'h2h').independent_model, false);
  eq('a run-time tier overrides the registry (a VALIDATED NFL total would price)', AD.modelCapability('americanfootball_nfl', 'totals', 'VALIDATED').may_price, true);
  eq('market aliases are understood', AD.modelCapability('americanfootball_nfl', 'spread').tier, 'LEAN');
  /* settlement */
  const nhl = AD.compareSettlement('icehockey_nhl', 'h2h', null, { overtime: false, terms_verified: true });
  eq('an NHL regulation-only contract against the two-way moneyline is a MATERIAL mismatch', [nhl.verified, nhl.mismatch_severity], [false, 'MATERIAL']);
  const same = AD.compareSettlement('icehockey_nhl', 'h2h', null, { overtime: true, terms_verified: true });
  eq('…the same terms match', [same.verified, same.mismatch_severity], [true, null]);
  const lp = AD.compareSettlement('baseball_mlb', 'h2h', null, { overtime: true, listed_pitchers: false, terms_verified: true });
  eq('MLB listed-pitchers vs action on the result is MINOR', lp.mismatch_severity, 'MINOR');
  const unk = AD.compareSettlement('baseball_mlb', 'h2h', null, {});
  eq('terms not on file are UNVERIFIED, never assumed equal', unk.mismatch_severity, 'UNVERIFIED');
  const soccer3 = AD.compareSettlement('americanfootball_nfl', 'h2h', null, { overtime: true, three_way: true, terms_verified: true });
  eq('a three-way contract against a two-way reference is MATERIAL', soccer3.mismatch_severity, 'MATERIAL');
  const tbl = AD.capabilityTable({ month: 10 });
  chk('the capability table lists soccer, tennis and golf as not covered, with reasons', ['soccer', 'tennis', 'golf'].every((s) => tbl.some((r) => r.sport === s && r.not_covered)), tbl.map((r) => r.sport));
  eq('key roles: MLB SP, NHL G, NFL QB', [AD.keyRoles('baseball_mlb'), AD.keyRoles('icehockey_nhl'), AD.keyRoles('americanfootball_nfl')], [['SP'], ['G'], ['QB']]);
}

/* ═══ 2. A CLEAN CANDIDATE IS CONFIRMED — on fresh data ═════════════════ */
{
  const a = AU.auditCandidate(candidate(), evidence(), { now: NOW });
  eq('every critical check passes: CONFIRMED', a.status, 'CONFIRMED');
  eq('fifteen checks ran', a.checks.length, 15);
  eq('the independent EV is recomputed exactly from the fresh read', check(a, 'A4_INDEPENDENT_EV').result, 'PASS');
  chk('…by two methods (capture Shin, sharp multiplicative)', a.recomputed.evaluations.length === 2 && a.recomputed.evaluations.every((x) => x.ev_per_dollar > 0), a.recomputed.evaluations);
  eq('the edge survives both methods', check(a, 'A5_METHOD_ROBUST').result, 'PASS');
  eq('books confirm', check(a, 'A7_CONFIRMATION').result, 'PASS');
  eq('starters match', check(a, 'A9_STARTER').result, 'PASS');
  const r = F.evaluateWager({ book: 'fanduel', american: 120, fair_probability: 0.4655, fair_source: { kind: 'SHARP_NO_VIG', observed_at: T(2) }, quote_observed_at: T(5), now: NOW, confirmation: { pass: true, books: 5 }, audit: { status: a.status } });
  eq('EDFAIR with a CONFIRMED audit: VERIFIED EDGE only when EV clears the bar (2.4% here, so it does)', r.classification, 'VERIFIED_EDGE');
  const r2 = F.evaluateWager({ book: 'fanduel', american: 120, fair_probability: 0.4655, fair_source: { kind: 'SHARP_NO_VIG', observed_at: T(2) }, quote_observed_at: T(5), now: NOW, confirmation: { pass: true, books: 5 }, audit: { status: 'DOWNGRADED' } });
  eq('…a DOWNGRADED audit is a POTENTIAL EDGE at most', r2.classification, 'POTENTIAL_EDGE');
}

/* ═══ 3. STALE PRICE: CORRECT → RECALCULATE → RE-AUDIT ═══════════════════ */
{
  const stale = candidate({ quote: { book: 'fanduel', odds_american: 120, odds_decimal: 2.2, captured_at: T(80), executable: true } });
  const out = AU.run({ candidates: [stale], gather: () => evidence({ fresh: freshRow({ best_dec: 2.24, best_book: 'draftkings', sharp_fair: 0.466, last_seen_at: T(3) }) }), now: NOW });
  const r = out.audited[0];
  eq('round 1 finds the stale quote correctable, round 2 confirms', [r.history.map((h) => h.status), r.audit.status], [['NEEDS_RECHECK', 'CONFIRMED'], 'CONFIRMED']);
  eq('the published candidate carries the corrected price, book and time', [r.candidate.quote.odds_decimal, r.candidate.quote.book, r.candidate.quote.captured_at], [2.24, 'draftkings', T(3)]);
  eq('…and the re-read fair, not the stale one', r.candidate.fair.probability, 0.466);
  chk('…with its EV recalculated by EDFAIR at the corrected inputs', /EDFAIR/.test(r.candidate.edge.recalculated_by) && Math.abs(r.candidate.edge.ev_per_unit - (0.466 * 1.24 - 0.534)) < 1e-6, r.candidate.edge);
  eq('the American price follows the decimal', r.candidate.quote.odds_american, 124);
  eq('the trail records AUDIT, VERDICT, CORRECT, RECALCULATE, RE-AUDIT, VERDICT, PUBLISH', out.trail.map((t) => t.step), ['AUDIT', 'VERDICT', 'CORRECT', 'RECALCULATE', 'RE-AUDIT', 'VERDICT', 'PUBLISH']);
  eq('it is in the verified list', out.verified.length, 1);
  chk('the original candidate object was not mutated', stale.quote.odds_decimal === 2.2 && stale.quote.captured_at === T(80));
}

/* ═══ 4. RECALCULATION CAN REJECT: the corrected price has no edge ═══════ */
{
  const out = AU.run({ candidates: [candidate()], gather: () => evidence({ fresh: freshRow({ best_dec: 2.1, last_seen_at: T(1) }) }), now: NOW });
  const r = out.audited[0];
  eq('the price moved 2.20 → 2.10: corrected, then rejected on value', [r.history.map((h) => h.status), r.audit.status], [['NEEDS_RECHECK', 'REJECTED'], 'REJECTED']);
  chk('…the reason is the recomputed EV under the floor', /under the .* floor/.test(r.audit.reason), r.audit.reason);
  eq('…nothing verified', out.verified.length, 0);
  eq('…it is listed as rejected', out.rejected.length, 1);
}

/* ═══ 5. THE AUDITOR REJECTS THE GENERATOR ═══════════════════════════════ */
{
  const bad = candidate({ edge: { ev_per_unit: 0.08, probability_edge_pp: 3 } });
  const a = AU.auditCandidate(bad, evidence(), { now: NOW });
  eq('a candidate EV that does not reproduce is a calculation failure: REJECTED', [a.status, check(a, 'A4_INDEPENDENT_EV').severity], ['REJECTED', 'INTEGRITY']);
  chk('…naming both numbers', /8\.00%/.test(a.reason) && /2\.4/.test(a.reason), a.reason);
  const moved = AU.auditCandidate(candidate(), evidence({ fresh: freshRow({ sharp_fair: 0.44, pin_dec: 2.2, pin_opp_dec: 1.72 }) }), { now: NOW });
  eq('the fresh sharp fair moved to 44%: the generator\'s +2.4% is now negative — REJECTED', moved.status, 'REJECTED');
  eq('…and the sharp movement is named', check(moved, 'A13_MOVEMENT').result, 'WARN');
  const started = AU.auditCandidate(candidate({ kickoff: T(10) }), evidence(), { now: NOW });
  eq('a game that started is REJECTED', started.status, 'REJECTED');
  const gone = AU.auditCandidate(candidate(), evidence({ fresh: freshRow({ suspended: true }) }), { now: NOW });
  eq('a suspended market is REJECTED (market unavailable)', gone.status, 'REJECTED');
  const out = AU.auditCandidate(candidate({ outlier: 'expected value 31% exceeds the 20% sanity ceiling' }), evidence(), { now: NOW });
  eq('an outlier is REJECTED as a data check', [out.status, check(out, 'A15_SANITY').result], ['REJECTED', 'FAIL']);
}

/* ═══ 6. INJURY UPDATE INVALIDATION ══════════════════════════════════════ */
{
  const nfl = candidate({ id: 'nfl|g2|spreads|home', sport: 'americanfootball_nfl', sport_label: 'NFL', market: 'spreads', home: 'Houston Texans', away: 'Tennessee Titans', selection: 'Houston Texans', starters: null });
  const qbOut = [{ team: 'Houston Texans', player: 'C.J. Stroud', role: 'QB', status: 'Out', observed_at: T(2), source: 'official NFL injury report (nflverse)' }];
  const a = AU.auditCandidate(nfl, evidence({ availability: qbOut, starters_now: null }), { now: NOW });
  eq('a QB ruled out AFTER the quote invalidates it: NEEDS_RECHECK', [a.status, check(a, 'A8_AVAILABILITY').result], ['NEEDS_RECHECK', 'FAIL']);
  chk('…the detail names the player, the time and the source', /Stroud/.test(check(a, 'A8_AVAILABILITY').detail) && /injury report/.test(check(a, 'A8_AVAILABILITY').detail), check(a, 'A8_AVAILABILITY'));
  const before = AU.auditCandidate(nfl, evidence({ availability: [Object.assign({}, qbOut[0], { observed_at: T(60) })], starters_now: null }), { now: NOW });
  eq('the same report BEFORE the quote is already in the price: PASS', check(before, 'A8_AVAILABILITY').result, 'PASS');
  const wr = AU.auditCandidate(nfl, evidence({ availability: [{ team: 'Houston Texans', player: 'A WR', role: 'WR', status: 'Doubtful', observed_at: T(1) }], starters_now: null }), { now: NOW });
  eq('a non-key player after the quote is a warning: DOWNGRADED', [wr.status, check(wr, 'A8_AVAILABILITY').result], ['DOWNGRADED', 'WARN']);
  const other = AU.auditCandidate(nfl, evidence({ availability: [{ team: 'Dallas Cowboys', player: 'X', role: 'QB', status: 'Out', observed_at: T(1) }], starters_now: null }), { now: NOW });
  eq('news about a team not in the game does not touch it', check(other, 'A8_AVAILABILITY').result, 'PASS');
  const none = AU.auditCandidate(candidate({ sport: 'basketball_nba', sport_label: 'NBA', starters: null }), evidence({ availability: null, starters_now: null }), { now: NOW });
  eq('no availability source: NOT_CHECKED, and the audit cannot confirm', [check(none, 'A8_AVAILABILITY').result, none.status], ['NOT_CHECKED', 'DOWNGRADED']);
}

/* ═══ 7. INCORRECT STARTING PITCHER ══════════════════════════════════════ */
{
  const scratched = { home: { name: 'Gavin Williams', source: 'mlb_game_cards', observed_at: T(1) }, away: STARTERS.away };
  const a = AU.auditCandidate(candidate(), evidence({ starters_now: scratched }), { now: NOW });
  eq('the price assumed Bibee, the card now lists Williams: the starter check fails', check(a, 'A9_STARTER').result, 'FAIL');
  chk('…naming both pitchers', /Bibee/.test(check(a, 'A9_STARTER').detail) && /Williams/.test(check(a, 'A9_STARTER').detail), check(a, 'A9_STARTER').detail);
  eq('…a market price must be re-quoted: NEEDS_RECHECK', a.status, 'NEEDS_RECHECK');
  const model = candidate({ fair: { method: 'MODEL_BLEND', probability: 0.4655 } });
  eq('…a MODEL price built on the wrong starter is REJECTED', AU.auditCandidate(model, evidence({ starters_now: scratched }), { now: NOW }).status, 'REJECTED');
  const unrecorded = AU.auditCandidate(candidate({ starters: null }), evidence(), { now: NOW });
  eq('a MARKET price whose starter is unknown is reported NOT_CHECKED without blocking (capture records no starter)', [check(unrecorded, 'A9_STARTER').result, unrecorded.status], ['NOT_CHECKED', 'CONFIRMED']);
  const unrecModel = AU.auditCandidate(candidate({ starters: null, fair: { method: 'MODEL_BLEND', probability: 0.4655 } }), evidence(), { now: NOW });
  eq('…a MODEL price that does not record its starter cannot be confirmed', [check(unrecModel, 'A9_STARTER').result, unrecModel.status], ['NOT_CHECKED', 'DOWNGRADED']);
  eq('case and spacing do not make a false mismatch', check(AU.auditCandidate(candidate({ starters: { home: 'tanner  bibee', away: 'SHANE BAZ' } }), evidence(), { now: NOW }), 'A9_STARTER').result, 'PASS');
}

/* ═══ 8. CONTRADICTORY AND FRAGILE EVIDENCE ═════════════════════════════ */
{
  const frag = AU.auditCandidate(candidate({ fair: { method: 'MARKET_DEVIG', probability: 0.4655 } }), evidence({ fresh: freshRow({ pin_dec: 2.25, pin_opp_dec: 1.70 }) }), { now: NOW });
  eq('positive under Shin, negative under multiplicative: method-dependent, DOWNGRADED', [check(frag, 'A5_METHOD_ROBUST').result, frag.status], ['WARN', 'DOWNGRADED']);
  const conf = AU.auditCandidate(candidate(), evidence({ fresh: freshRow({ consensus_fair: 0.43 }) }), { now: NOW });
  eq('sharp 46.6% vs consensus 43%: contradictory references, DOWNGRADED', [check(conf, 'A6_FAIR_CONSISTENCY').result, conf.status], ['WARN', 'DOWNGRADED']);
  const lone = AU.auditCandidate(candidate(), evidence({ books: [{ book: 'fanduel', dec: 2.2 }, { book: 'dk', dec: 1.98 }, { book: 'mgm', dec: 1.97 }, { book: 'czr', dec: 1.96 }] }), { now: NOW });
  eq('one off-market book with the rest far shorter: DOWNGRADED', [check(lone, 'A7_CONFIRMATION').result, lone.status], ['WARN', 'DOWNGRADED']);
  const failRead = AU.auditCandidate(candidate(), evidence({ fresh: null, fresh_error: 'signals read failed (503)' }), { now: NOW });
  eq('the fresh read failed: never CONFIRMED', [check(failRead, 'A3_STILL_OFFERED').result, failRead.status], ['NOT_CHECKED', 'DOWNGRADED']);
}

/* ═══ 9. MODEL DISAGREEMENT NEEDS A WRITTEN EXPLANATION ═════════════════ */
{
  const nfl = { sport: 'americanfootball_nfl', sport_label: 'NFL', market: 'spreads', starters: null, home: 'Houston Texans', away: 'Tennessee Titans', selection: 'Houston Texans' };
  const bare = AU.auditCandidate(candidate(Object.assign({}, nfl, { model_case: { gap_points: 9, cover_at_market: 0.6 } })), evidence({ starters_now: null }), { now: NOW });
  eq('a 9-point model gap with no explanation: REJECTED', [check(bare, 'A14_MODEL_DISAGREEMENT').result, bare.status], ['FAIL', 'REJECTED']);
  const said = AU.auditCandidate(candidate(Object.assign({}, nfl, { model_case: { gap_points: 9, cover_at_market: 0.6 }, explanation: ['Titans starting QB out (official report)', 'Texans pass rush vs Titans pass protection: +1.2 z'] })), evidence({ starters_now: null }), { now: NOW });
  eq('…with drivers written down it is STILL refused: 9 points is past EDINTEL\'s 7-point EXTREME limit (a suspected data fault)', [check(said, 'A14_MODEL_DISAGREEMENT').result, said.status], ['FAIL', 'REJECTED']);
  chk('…and the detail names the limit', /EXTREME/.test(check(said, 'A14_MODEL_DISAGREEMENT').detail), check(said, 'A14_MODEL_DISAGREEMENT').detail);
  const ppSaid = AU.auditCandidate(candidate(Object.assign({}, nfl, { model_case: { gap_points: 4, cover_at_market: 0.6 }, explanation: ['Titans starting QB out (official report)', 'Texans pass rush vs Titans pass protection: +1.2 z'] })), evidence({ starters_now: null }), { now: NOW });
  eq('a 4-point gap that is 13 probability points from the sharp fair, explained: a warning that carries the drivers, DOWNGRADED', [check(ppSaid, 'A14_MODEL_DISAGREEMENT').result, ppSaid.status], ['WARN', 'DOWNGRADED']);
  chk('…and the explanation rides in the detail', /pass rush/.test(check(ppSaid, 'A14_MODEL_DISAGREEMENT').detail));
  const ppBare = AU.auditCandidate(candidate(Object.assign({}, nfl, { model_case: { gap_points: 4, cover_at_market: 0.6 } })), evidence({ starters_now: null }), { now: NOW });
  eq('…unexplained, REJECTED', [check(ppBare, 'A14_MODEL_DISAGREEMENT').result, ppBare.status], ['FAIL', 'REJECTED']);
}

/* ═══ 10. SETTLEMENT, FEES AND LIQUIDITY ON A CONTRACT ══════════════════ */
{
  const nhl = candidate({ sport: 'icehockey_nhl', sport_label: 'NHL', starters: null, home: 'Boston Bruins', away: 'Toronto Maple Leafs', selection: 'Toronto Maple Leafs' });
  const a = AU.auditCandidate(nhl, evidence({ starters_now: null, settlement: { overtime: false, terms_verified: true } }), { now: NOW });
  eq('a regulation-only contract priced against the two-way moneyline: REJECTED', [check(a, 'A10_SETTLEMENT').result, a.status], ['FAIL', 'REJECTED']);
  const ct = F.evaluateContract({ venue: 'polymarket', side: 'YES', price_cents: 45, fair_probability: 0.4655, fair_source: { kind: 'SHARP_NO_VIG' }, quote_observed_at: T(2), now: NOW });
  const b = AU.auditCandidate(candidate(), evidence({ contract: ct }), { now: NOW });
  eq('a contract whose venue fees are unknown fails the fee check: REJECTED (net EV unknowable)', [check(b, 'A11_FEES').result, b.status], ['FAIL', 'REJECTED']);
  const ct2 = F.evaluateContract({ venue: 'kalshi', side: 'YES', price_cents: 45, contracts: 500, orderbook: { asks: [[0.45, 100], [0.46, 50]] }, fair_probability: 0.4655, fair_source: { kind: 'SHARP_NO_VIG' }, quote_observed_at: T(2), now: NOW });
  const c = AU.auditCandidate(candidate(), evidence({ contract: ct2 }), { now: NOW });
  eq('500 contracts against 150 on the book: liquidity FAIL', check(c, 'A12_LIQUIDITY').result, 'FAIL');
  eq('…and Kalshi\'s unverified schedule is a fee WARN, not a pass', check(c, 'A11_FEES').result, 'WARN');
}

/* ═══ 11. THE LOOP IS BOUNDED ════════════════════════════════════════════ */
{
  let calls = 0;
  /* every read finds the price a little worse again: correctable forever, in principle */
  const out = AU.run({ candidates: [candidate()], gather: (c, round) => { calls++; return evidence({ fresh: freshRow({ best_dec: 2.2 - 0.005 * round, last_seen_at: T(1) }) }); }, now: NOW, max_rounds: 2 });
  const r = out.audited[0];
  chk('it stops at the round limit', r.rounds <= 2 && calls <= 2, { rounds: r.rounds, calls });
  chk('…ending in an explicit state, never CONFIRMED by exhaustion', r.audit.status !== 'CONFIRMED', r.audit.status);
  chk('the round limit cannot be raised past 3', AU.run({ candidates: [candidate()], gather: () => evidence(), now: NOW, max_rounds: 99 }).max_rounds === 3);
  const many = AU.run({ candidates: [candidate({ id: 'a' }), candidate({ id: 'b' }), candidate({ id: 'c' }), candidate({ id: 'd' })], gather: () => evidence(), now: NOW });
  eq('only the top 3 are audited by default (the second stage is for the strongest)', many.audited.length, 3);
  const thrown = AU.run({ candidates: [candidate()], gather: () => { throw new Error('host read blew up'); }, now: NOW });
  chk('a gather that throws is contained by the caller, not silently confirmed', thrown == null || thrown.audited == null || thrown.audited.every((x) => x.audit.status !== 'CONFIRMED'));
}

/* ═══ 14. INDEPENDENT-AUDIT REGRESSIONS (quant audit H1 H2 M2 M3 L6 L7 L8) ═══ */
{
  /* H1 a fresh read with no fair never confirms on the candidate's own copy */
  const noFair = freshRow({ sharp_fair: null, pin_dec: null, pin_opp_dec: null, consensus_fair: null });
  const h1 = AU.auditCandidate(candidate(), evidence({ fresh: noFair, books: null }), { now: NOW });
  eq('H1: no fresh fair: A4 does not PASS, the audit is not CONFIRMED', [check(h1, 'A4_INDEPENDENT_EV').result !== 'PASS', h1.status, h1.independent_ev, h1.independent_fair], [true, 'DOWNGRADED', null, null]);
  eq('H1: …and A13 has nothing to compare', check(h1, 'A13_MOVEMENT').result, 'NOT_CHECKED');
  chk('H1: …the recomputation lists no CAPTURE_SHIN fair borrowed from the candidate', !h1.recomputed.fairs.some((f) => f.method === 'CAPTURE_SHIN'), h1.recomputed.fairs);
  const fx = AU.recompute(candidate(), null, NOW, 45);
  eq('H1: recompute with no fresh read has no fairs at all', fx.fairs.length, 0);
  /* H1 in the loop: a stale quote "corrected" by a read with no fair is held, not re-priced on the old fair */
  const stale = candidate({ quote: Object.assign({}, candidate().quote, { captured_at: T(200) }) });
  const held = AU.run({ candidates: [stale], gather: () => evidence({ fresh: freshRow({ best_dec: 2.25, sharp_fair: null, pin_dec: null, pin_opp_dec: null, last_seen_at: T(1) }) }), now: NOW });
  const hr = held.audited[0];
  eq('H1: the correction is held: NEEDS_RECHECK, not CONFIRMED', [hr.audit.status, hr.audit.correction_held, (hr.candidate.corrected || []).length, hr.candidate.quote.odds_decimal], ['NEEDS_RECHECK', true, 0, 2.2]);
  chk('H1: …the trail says why', held.trail.some((t) => t.step === 'HOLD' && /no fair probability/.test(t.detail)), held.trail.map((t) => t.step));
  eq('H1: …and nothing is verified', held.verified.length, 0);
  /* …but a read with the sharp book's two sides still re-prices it */
  const pinOnly = AU.run({ candidates: [stale], gather: () => evidence({ fresh: freshRow({ best_dec: 2.25, sharp_fair: null, pin_dec: 2.08, pin_opp_dec: 1.81, last_seen_at: T(1) }) }), now: NOW });
  const pr = pinOnly.audited[0];
  chk('H1: a fresh read with the sharp book\'s two sides supplies the fair (multiplicative de-vig)', pr.candidate.fair.reread === true && Math.abs(pr.candidate.fair.probability - (1 / 2.08) / (1 / 2.08 + 1 / 1.81)) < 1e-9, pr.candidate.fair);
  /* H2 the audit reports the fair behind its EV */
  const moved = AU.auditCandidate(candidate(), evidence({ fresh: freshRow({ sharp_fair: 0.4605, pin_dec: 2.12, pin_opp_dec: 1.78 }), books: [{ book: 'fanduel', dec: 2.2 }, { book: 'dk', dec: 2.18 }, { book: 'mgm', dec: 2.18 }, { book: 'czr', dec: 2.12 }] }), { now: NOW });
  eq('H2: the audit exposes the fresh fair it priced (0.4605), not the candidate\'s 0.4655', [moved.independent_fair, moved.independent_fair_method, moved.independent_price_decimal], [0.4605, 'CAPTURE_SHIN', 2.2]);
  const atFresh = F.evaluateWager({ decimal: '2.2', fair_probability: String(moved.independent_fair), fair_source: { kind: 'SHARP_NO_VIG', observed_at: T(2) }, quote_observed_at: T(5), now: NOW, ttl_min: 45, confirmation: { pass: true }, audit: { status: moved.status }, settlement: { verified: true } });
  eq('H2: priced on that fair the same price is WATCH (1.31%), not VERIFIED (2.41% on the stale fair)', [atFresh.classification, Number(atFresh.net_ev_per_dollar).toFixed(4)], ['WATCH', '0.0131']);
  /* M2 one book clearing is not confirmation */
  const one = AU.auditCandidate(candidate(), evidence({ books: [{ book: 'fanduel', dec: 2.2 }, { book: 'dk', dec: 2.12 }, { book: 'mgm', dec: 2.10 }, { book: 'czr', dec: 2.08 }] }), { now: NOW });
  eq('M2: 1 of 4 books clearing the floor: WARN, DOWNGRADED', [check(one, 'A7_CONFIRMATION').result, one.status], ['WARN', 'DOWNGRADED']);
  const zero = AU.auditCandidate(candidate(), evidence({ books: [{ book: 'dk', dec: 2.12 }, { book: 'mgm', dec: 2.10 }, { book: 'czr', dec: 2.08 }] }), { now: NOW });
  eq('M2: 0 of 3: WARN', check(zero, 'A7_CONFIRMATION').result, 'WARN');
  eq('M2: 2 or more clearing: PASS', check(AU.auditCandidate(candidate(), evidence(), { now: NOW }), 'A7_CONFIRMATION').result, 'PASS');
  /* M3 availability on missing or old data */
  const nfl = candidate({ id: 'nfl|g2|spreads|home', sport: 'americanfootball_nfl', sport_label: 'NFL', market: 'spreads', home: 'Houston Texans', away: 'Tennessee Titans', selection: 'Houston Texans', starters: null });
  const emptyUnresolved = AU.auditCandidate(nfl, evidence({ availability: [], availability_complete: false, availability_why: 'neither team code resolved', starters_now: null }), { now: NOW });
  eq('M3: an empty list when no team resolved: NOT_CHECKED, not CONFIRMED', [check(emptyUnresolved, 'A8_AVAILABILITY').result, emptyUnresolved.status], ['NOT_CHECKED', 'DOWNGRADED']);
  const untimedQb = AU.auditCandidate(nfl, evidence({ availability: [{ team: 'Houston Texans', player: 'C.J. Stroud', role: 'QB', key: true, status: 'Out', observed_at: null }], starters_now: null }), { now: NOW });
  eq('M3: a starting QB Out with no report time: NOT_CHECKED, not CONFIRMED', [check(untimedQb, 'A8_AVAILABILITY').result, untimedQb.status], ['NOT_CHECKED', 'DOWNGRADED']);
  const old = AU.auditCandidate(nfl, evidence({ availability: [{ team: 'Houston Texans', player: 'A WR', role: 'WR', status: 'Questionable', observed_at: T(6 * 24 * 60) }], availability_as_of: T(6 * 24 * 60), starters_now: null }), { now: NOW });
  eq('M3: a six-day-old report: WARN (past the 72-hour limit), DOWNGRADED', [check(old, 'A8_AVAILABILITY').result, old.status], ['WARN', 'DOWNGRADED']);
  chk('M3: …saying how old', /144 hours old/.test(check(old, 'A8_AVAILABILITY').detail), check(old, 'A8_AVAILABILITY').detail);
  /* L6 the kickoff guard */
  const late = AU.auditCandidate(candidate({ kickoff: new Date(NOW + 60000).toISOString(), quote: Object.assign({}, candidate().quote, { captured_at: new Date(NOW - 30000).toISOString() }) }), evidence({ fresh: freshRow({ last_seen_at: new Date(NOW - 30000).toISOString() }) }), { now: NOW });
  eq('L6: kickoff a minute away: A1 fails, never CONFIRMED', [check(late, 'A1_GAME_STATUS').result, late.status === 'CONFIRMED'], ['FAIL', false]);
  /* L7 a corrected MODEL candidate is relabelled as the market fair it now carries */
  const model = candidate({ fair: { method: 'MODEL_BLEND', probability: 0.5, validation: { tier: 'LEAN', model_version: 'v1' } }, edge: { ev_per_unit: 0.1 }, starters: null, model_case: { gap_points: 2 }, quote: Object.assign({}, candidate().quote, { captured_at: T(200) }) });
  const fx2 = AU.applyCorrections(model, { correctable: [{ check: 'A2_QUOTE_FRESH', field: 'quote', to: { captured_at: T(1), odds_decimal: 2.2, book: 'fanduel', fair_probability: 0.4655 }, why: 'stale' }] }, NOW);
  eq('L7: the re-read market fair is not shown as the model\'s', [fx2.candidate.fair.method, fx2.candidate.fair.validation, fx2.candidate.fair.probability, fx2.candidate.model_case], ['SHARP_REREAD', null, 0.4655, null]);
  /* L8 A5 measured against the floor */
  const thin = AU.auditCandidate(candidate(), evidence({ fresh: freshRow({ pin_dec: 2.1, pin_opp_dec: 1.7632 }) }), { now: NOW });
  const mult = thin.recomputed.evaluations.find((x) => x.method === 'SHARP_MULTIPLICATIVE');
  chk('L8: (setup) the multiplicative EV is positive but under the 0.5% floor', mult && mult.ev_per_dollar > 0 && mult.ev_per_dollar < 0.005, mult);
  eq('L8: …so the edge is method-dependent: WARN', check(thin, 'A5_METHOD_ROBUST').result, 'WARN');
}

/* ═══ 12. ASYNC GATHER AND RANKING BY INDEPENDENT EV ════════════════════ */
(async () => {
  const a = candidate({ id: 'a', quote: { book: 'fanduel', odds_american: 120, odds_decimal: 2.2, captured_at: T(5), executable: true } });
  const b = candidate({ id: 'b', quote: { book: 'fanduel', odds_american: 125, odds_decimal: 2.25, captured_at: T(5), executable: true }, edge: { ev_per_unit: Math.round((0.4655 * 1.25 - 0.5345) * 1e4) / 1e4 } });
  const out = await AU.run({ candidates: [a, b], gather: (c) => Promise.resolve(evidence({ fresh: freshRow({ best_dec: c.quote.odds_decimal }) })), now: NOW });
  eq('an async gather is awaited', out.audited.length, 2);
  eq('verified opportunities are ranked by the auditor\'s own EV, best first', out.verified.map((r) => r.candidate.id), ['b', 'a']);
  eq('the checks list rides with the result', out.checks.length, 15);
  done();
})().catch((e) => { console.error(e); process.exit(1); });
