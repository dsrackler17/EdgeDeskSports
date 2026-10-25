#!/usr/bin/env node
/* ===========================================================================
   Market Foresight — the engine (lib/edgedesk_foresight.js) on a synthetic
   world whose answers were worked by hand (tools/foresight/fixtures/
   synthetic.js). Every expected number below is written out, not computed
   by the code under test.

     node tools/foresight/engine.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const E = require(path.join(ROOT, 'lib', 'edgedesk_foresight.js'));
const S = require(path.join(__dirname, 'fixtures', 'synthetic.js'));
const PG = require(path.join(ROOT, 'tools', 'personal', '_pg.js'));
const T = PG.kit('Market Foresight engine');
const chk = T.chk;

const MPATH = path.join(ROOT, 'research', 'foresight', 'methodology', 'mf-v1.json');
const M = JSON.parse(fs.readFileSync(MPATH, 'utf8'));
const FROZEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'research', 'foresight', 'methodology', 'FROZEN.json'), 'utf8'));
const R = E.rules(M);
const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= (tol || 1e-6);
const H = S.H;

/* ---------------------------------------------------------------- the methodology is frozen */
const sha = crypto.createHash('sha256').update(fs.readFileSync(MPATH)).digest('hex');
chk('mf-v1 has the digest it was frozen with', sha === FROZEN.versions['mf-v1'].sha256, sha);
chk('and that digest is the one this test was written against', sha === '9cd1de3c9076640fcff167988fd1a9290106dbff9776245101b5e141f9caa4d0', sha);
chk('rules: thresholds 0.5 pts / 2 pp, horizons 1/6/24 h', R.threshold.spread === 0.5 && R.threshold.total === 0.5 && R.threshold.moneyline === 0.02 && R.horizons.join() === '60,360,1440');
chk('rules: DraftKings gap bound 450 far / 140 inside the close zone; Kalshi 20', R.dk.far === 450 && R.dk.zone === 140 && R.kalshiGap === 20);
chk('a non-methodology object is refused', (() => { try { E.rules({ version: 'x' }); return false; } catch (_) { return true; } })());

/* ---------------------------------------------------------------- prices */
const d1 = E.devig(-110, -110, R.overround);
chk('de-vig -110/-110: 0.5 each, overround 0.047619', near(d1.a, 0.5) && near(d1.overround, 0.047619, 1e-6));
const d2 = E.devig(-150, 130, R.overround);
chk('de-vig -150/+130: home 0.579832', near(d2.a, 0.579832, 1e-6));
chk('a missing opposing price gives no fair probability (one_sided_price)', E.devig(-150, null, R.overround).flag === 'one_sided_price');
chk('an impossible American price is refused (invalid_price)', E.devig(-50, 120, R.overround).flag === 'invalid_price');
chk('an overround outside [0, 0.2] is flagged, not used', E.devig(-400, -400, R.overround).flag === 'implausible_overround');

const mlObs = E.dkObservation(S.ml('X', S.K1, -3, -300, null), R);
chk('a one-sided moneyline observation keeps its raw price and has no value', mlObs.value === null && mlObs.flag === 'one_sided_price' && mlObs.raw.price_home === -300);
const spObs = E.dkObservation(S.sp('X', S.K1, -3, -3.5), R);
chk('a spread observation: the line is the value; its own -3.5 cover probability is labelled with its threshold', spObs.value === -3.5 && spObs.contract.threshold === -3.5 && near(spObs.contract.p, 0.5, 1e-9));

/* thresholds are never spliced */
const thr = E.buildSeries([E.dkObservation(S.sp('X', S.K1, -5, -3), R), E.dkObservation(S.sp('X', S.K1, -4, -3.5), R), E.dkObservation(S.sp('X', S.K1, -3, -3), R)], 'draftkings', 'spread', S.K1, R);
const ts = E.thresholdSeries(thr.segments);
chk('threshold change: -3 and -3.5 are two cover-probability series, never one', Object.keys(ts).sort().join() === '-3,-3.5' && ts['-3'].length === 2 && ts['-3.5'].length === 1);

/* Kalshi quote types */
const kq = (o) => Object.assign({ id: 1, captured_at: '2026-11-01T10:00:00Z', yes_bid_size: 100, yes_ask_size: 80, volume: 500 }, o);
let k = E.kalshiObservation(kq({ yes_bid: 0.45, yes_ask: 0.47, last_price: 0.46 }), kq({ volume: 500 }), R);
chk('Kalshi: mid 0.46 from bid 0.45 / ask 0.47, spread 0.02', near(k.value, 0.46) && near(k.raw.spread, 0.02) && k.quote_type === 'kalshi_mid');
chk('Kalshi: an unchanged volume makes the last trade stale (never a fresh quote)', k.raw.last_trade === 'stale');
k = E.kalshiObservation(kq({ yes_bid: 0.45, yes_ask: 0.47, last_price: 0.46, volume: 520 }), kq({ volume: 500 }), R);
chk('Kalshi: a rising volume makes the last trade fresh', k.raw.last_trade === 'fresh');
k = E.kalshiObservation(kq({ yes_bid: 0.45, yes_ask: 0.47, last_price: 0.46 }), null, R);
chk('Kalshi: with no previous snapshot the last trade is unknown', k.raw.last_trade === 'unknown');
k = E.kalshiObservation(kq({ yes_bid: 0.40, yes_ask: 0.47 }), null, R);
chk('Kalshi: a 7-cent spread is wide: no mid', k.value === null && k.flag === 'wide_spread');
k = E.kalshiObservation(kq({ yes_bid: 0.44, yes_ask: 0.50 }), null, R);
chk('Kalshi: exactly 6 cents is trusted (mid 0.47)', near(k.value, 0.47));
k = E.kalshiObservation(kq({ yes_bid: 0, yes_ask: 0.5 }), null, R);
chk('Kalshi: a zero bid is one-sided', k.value === null && k.flag === 'one_sided');
k = E.kalshiObservation(kq({ yes_bid: 0.45, yes_ask: 0.47, yes_ask_size: null }), null, R);
chk('Kalshi: missing depth is flagged, never assumed', k.raw.depth === 'missing');

/* ---------------------------------------------------------------- settlement */
const nflF = { source: 'edgedesk', sport: 'nfl', settles: 'includes overtime (a tie grades by house rule)' };
chk('settlement: an NFL two-way forecast and the DraftKings moneyline (tie = push) are compatible', E.settlementIssue(E.forecastProfile(nflF, R), E.venueProfile('draftkings', 'nfl', R), R) === null);
chk('settlement: Kalshi without a verification is unverified', E.settlementIssue(E.forecastProfile(nflF, R), E.venueProfile('kalshi', 'nfl', R, null), R) === 'settlement_unverified');
chk('settlement: a verified Kalshi profile that pushes a tie is compatible', E.settlementIssue(E.forecastProfile(nflF, R), E.venueProfile('kalshi', 'nfl', R, { verified: true, overtime: 'included', tie: 'push' }), R) === null);
chk('settlement: a Kalshi profile that settles a tie as NO is a mismatch', E.settlementIssue(E.forecastProfile(nflF, R), E.venueProfile('kalshi', 'nfl', R, { verified: true, overtime: 'included', tie: 'no' }), R) === 'settlement_mismatch');
chk('settlement: regulation-only would be a mismatch', E.settlementIssue(E.forecastProfile(nflF, R), { overtime: 'excluded', tie: 'push', verified: true }, R) === 'settlement_mismatch');
chk('settlement: a forecast that states no settlement is undocumented', E.forecastProfile({ source: 'edgedesk', sport: 'nfl', settles: null }, R) === null);
chk('settlement: CFB (no ties) forecast vs DraftKings CFB moneyline', E.settlementIssue(E.forecastProfile({ source: 'edgedesk', sport: 'cfb', settles: 'x' }, R), E.venueProfile('draftkings', 'cfb', R), R) === null);
chk('settlement: an NFL forecast is never compared with a CFB profile', E.settlementIssue(E.forecastProfile(nflF, R), E.venueProfile('draftkings', 'cfb', R), R) === 'settlement_mismatch');

/* ---------------------------------------------------------------- gaps */
chk('gap bound: 6 h + 90 min far from kickoff', E.maxGapAfter('draftkings', S.K1 - 30 * H, S.K1, R) === 450);
chk('gap bound: 50 + 90 min inside the close zone', E.maxGapAfter('draftkings', S.K1 - 2.5 * H, S.K1, R) === 140);
chk('gap bound: crossing into the zone (heartbeat due at zone start, 3 h after t1)', E.maxGapAfter('draftkings', S.K1 - 8 * H, S.K1, R) === 390);

/* ---------------------------------------------------------------- one game end to end: G1 */
const NOW = S.K3 + 24 * H;
const g1 = E.evaluateGame(S.G1, R, NOW);
const U = (model, market, venue) => g1.units.filter((u) => u.model_key === model && u.market === (market || 'spread') && u.venue === (venue || 'draftkings'))[0];
const sp1 = g1.series['draftkings:spread'];
chk('G1: duplicate ingestion is one observation (8 points)', sp1.points.length === 8, sp1.points.length);
chk('G1: no coverage gap', sp1.gaps.length === 0, sp1.gaps);
chk('G1: run-length segments -3, -3.5, -4, -4.5', sp1.segments.map((s) => s.value).join() === '-3,-3.5,-4,-4.5');
chk('G1: the duplicate forecast record is one forecast', g1.game.forecasts.filter((f) => f.forecast_id === 'syn_a@SYN_G1@-22').length === 1);

let u = U('syn_b');
chk('B: measured', u && u.status === 'measured', u && u.exclusion_reason);
chk('B: M0 = -3.0 (the last observation at or before publication, 4 h old)', u.metrics.M0 === -3 && u.metrics.baseline.age_minutes === 240);
chk('B: C = -4.5, observed 30 minutes before kickoff', u.metrics.C === -4.5 && u.metrics.close.minutes_before_kickoff === 30);
chk('B: disagreement F - M0 = -3.0', u.metrics.disagreement === -3);
chk('B: closing convergence |M0-F| - |C-F| = 3.0 - 1.5 = 1.5', u.metrics.convergence === 1.5);
chk('B: directional movement sign(F-M0)(C-M0) = 1.5', u.metrics.directional === 1.5);
chk('B: PRECEDED — an observation after publication (K-24h) still showed -3.0', u.metrics.move.status === 'QUALIFIED' && u.metrics.move.precedence === 'PRECEDED');
chk('B: the move lies in (K-24h, K-20h], 120 to 360 minutes after publication', u.metrics.move.lo === S.at(S.K1, -24) && u.metrics.move.hi === S.at(S.K1, -20) && u.metrics.move.minutes_from_publication.join() === '120,360');
chk('B: horizons 1 h = 0, 6 h = 0.5, 24 h = 1.0', u.metrics.horizons.map((h) => h.movement).join() === '0,0.5,1');
chk('B: TOWARD_HELD, no overshoot', u.metrics.cls === 'TOWARD_HELD' && !u.metrics.overshoot);
chk('B: the later revision is shown, not used', u.forecast_value === -6 && u.revisions.length === 1 && u.revisions[0].value === -4);
chk('B: finding says the forecast was published before the first observed sustained move', /published before the first observed sustained move/.test(E.renderFinding(u.finding)) && u.finding.code === 'PRECEDED');

u = U('syn_a');
chk('A: UNRESOLVED — no observation between publication (K-22h) and the move', u.metrics.move.precedence === 'UNRESOLVED' && u.metrics.move.lo === S.at(S.K1, -24));
chk('A: convergence 1.5, directional 1.5', u.metrics.convergence === 1.5 && u.metrics.directional === 1.5);
chk('A: the 24 h horizon is past kickoff: censored', u.metrics.horizons[2].status === 'censored_after_kickoff' && u.metrics.horizons[1].movement === 0.5);
chk('A: the finding says timing is unresolved at available sampling resolution', /unresolved at available sampling resolution/.test(E.renderFinding(u.finding)));

u = U('syn_c');
chk('C: overshoot — convergence 0.5, directional 1.5, the close went past the forecast', u.metrics.convergence === 0.5 && u.metrics.directional === 1.5 && u.metrics.overshoot === true && u.metrics.cls === 'TOWARD_HELD');
u = U('syn_d');
chk('D: moved away — convergence -1.5, directional -1.5, MOVED_AWAY', u.metrics.convergence === -1.5 && u.metrics.directional === -1.5 && u.metrics.cls === 'MOVED_AWAY' && u.metrics.move.status === 'NONE');
u = U('syn_e');
chk('E: |F - M0| = 0.2 < 0.5: no material disagreement, still counted (convergence -1.1)', u.status === 'measured' && u.metrics.cls === 'NO_MATERIAL_DISAGREEMENT' && u.metrics.convergence === -1.1 && u.metrics.directional === null);
u = U('syn_f');
chk('F: published before the first observation: no fresh baseline', u.status === 'excluded' && u.exclusion_reason === 'no_fresh_baseline');
u = U('syn_g');
chk('G: the reconstructed record is skipped by rule; the first eligible (-6.5 at K-21h) is the unit', u.forecast_value === -6.5 && u.earlier_ineligible.length === 1 && u.earlier_ineligible[0].issue === 'publication_time_reconstructed');
chk('G: convergence 3.5 - 2.0 = 1.5', u.metrics.convergence === 1.5);
u = U('syn_h');
chk('H: published after kickoff: excluded', u.status === 'excluded' && u.exclusion_reason === 'published_at_or_after_cutoff');

/* Collective units */
chk('m2: PRECEDED, convergence 1.5', U('m2').metrics.move.precedence === 'PRECEDED' && U('m2').metrics.convergence === 1.5);
chk('m3: MOVED_AWAY, convergence -0.5', U('m3').metrics.cls === 'MOVED_AWAY' && U('m3').metrics.convergence === -0.5);
chk('m4 (withdrawn later) is still a unit, not silently dropped', !!U('m4') && U('m4').exclusion_reason === 'no_fresh_baseline');
chk('m5 (backfill) is excluded as not live', U('m5').exclusion_reason === 'not_live_origin');
chk('m6 (inside the 30-minute lock) is excluded', U('m6').exclusion_reason === 'published_at_or_after_cutoff');

/* consensus, strictly as of */
const cs = (off) => g1.game.consensus.filter((c) => c.offset_minutes === off)[0].markets.spread;
chk('consensus K-48h: only m1 (backfill m5 and later m4 excluded): insufficient', cs(2880).status === 'INSUFFICIENT_CONTRIBUTORS' && cs(2880).n === 1);
chk('consensus K-24h: m1 -4, m2 -6, m4 -2 (withdrawn only later): mean -4, median -4, sd 2, iqr 2',
  cs(1440).status === 'OK' && cs(1440).n === 3 && cs(1440).mean === -4 && cs(1440).median === -4 && cs(1440).sd === 2 && cs(1440).iqr === 2);
chk('consensus K-6h: m1 revised to -5, m2 -6; m3 is published later (no leakage), m4 withdrawn: n = 2, insufficient',
  cs(360).status === 'INSUFFICIENT_CONTRIBUTORS' && cs(360).n === 2 && cs(360).members.map((m) => m.value).join() === '-5,-6');
chk('consensus K-2h: m1 -5, m2 -6, m3 -3 (m6 is after): mean -4.6667, median -5', near(cs(120).mean, -4.6667, 1e-4) && cs(120).median === -5 && cs(120).n === 3);
chk('consensus: one vote per model (m1 has two forecasts, one member)', cs(120).members.filter((m) => m.model_key === 'm1').length === 1);
chk('consensus: membership is hashed', /^mfm-[0-9a-f]{16}$/.test(cs(120).membership_hash));
const c1440 = g1.units.filter((x) => x.model_key === 'collective-consensus-1440m' && x.model_version === 'equal_weight_mean')[0];
chk('consensus unit K-24h (mean -4): an observation at the evaluation time showed -3.0, so PRECEDED; convergence 0.5, directional 1.5, overshoot',
  c1440.metrics.move.precedence === 'PRECEDED' && c1440.metrics.convergence === 0.5 && c1440.metrics.directional === 1.5 && c1440.metrics.overshoot === true);
const c120m = g1.units.filter((x) => x.model_key === 'collective-consensus-120m' && x.model_version === 'median')[0];
chk('consensus unit K-2h (median -5): convergence 0.5, UNRESOLVED', c120m.metrics.convergence === 0.5 && c120m.metrics.move.precedence === 'UNRESOLVED');
chk('consensus units carry their membership', c120m.membership && c120m.membership.spread && c120m.membership.spread.n === 3);

/* ---------------------------------------------------------------- G2: flicker and reversal */
const g2 = E.evaluateGame(S.G2, R, NOW);
u = g2.units.filter((x) => x.model_key === 'syn_t' && x.market === 'total')[0];
chk('G2: the K-8h crossing is a flicker (undone at K-7h); the qualifying move is (K-7h, K-5h]', u.metrics.move.lo === S.at(S.K2, -7) && u.metrics.move.hi === S.at(S.K2, -5));
chk('G2: PRECEDED, 120 to 240 minutes after publication', u.metrics.move.precedence === 'PRECEDED' && u.metrics.move.minutes_from_publication.join() === '120,240');
chk('G2: reversed before the close: TOWARD_REVERSED, directional 0, convergence 0 (equal)', u.metrics.cls === 'TOWARD_REVERSED' && u.metrics.directional === 0 && u.metrics.convergence === 0 && u.metrics.closer === 'equal');
chk('G2: the finding names the reversal', /reversed before the close/.test(E.renderFinding(u.finding)));

/* ---------------------------------------------------------------- G3: outage and a missing price */
const g3 = E.evaluateGame(S.G3, R, NOW);
const U3 = (m, mk, v) => g3.units.filter((x) => x.model_key === m && x.market === (mk || 'spread') && x.venue === (v || 'draftkings'))[0];
chk('G3: the 20-hour silence and the 19-hour silence are two coverage gaps', g3.series['draftkings:spread'].gaps.length === 2);
chk('G3: a 10-hour-old observation is stale at publication: never carried through the outage', U3('syn_o1').exclusion_reason === 'no_fresh_baseline' && U3('syn_o1').metrics.baseline.reason === 'stale');
chk('G3: o2 measured, no qualifying move, convergence 0', U3('syn_o2').metrics.cls === 'NO_QUALIFYING_MOVE' && U3('syn_o2').metrics.convergence === 0);
chk('G3: o3 move interval spans the outage and is UNRESOLVED', U3('syn_o3').metrics.move.spans_gap === true && U3('syn_o3').metrics.move.precedence === 'UNRESOLVED');
chk('G3: a baseline with no opposing price is unpriced, not estimated', U3('syn_ml', 'moneyline').exclusion_reason === 'baseline_unpriced');
chk('G3: the same forecast against Kalshi is blocked: settlement unverified', U3('syn_ml', 'moneyline', 'kalshi').exclusion_reason === 'settlement_unverified');

/* ---------------------------------------------------------------- G4 postponed, G5 missing close */
const g4 = E.evaluateGame(S.G4, R, NOW);
chk('G4: a postponed game excludes every unit (event_void)', g4.units.length > 0 && g4.units.every((x) => x.exclusion_reason === 'event_void'));
const g5 = E.evaluateGame(S.G5, R, NOW);
chk('G5: the last observation 5 h before kickoff is no close: excluded, never replaced', g5.units[0].exclusion_reason === 'no_valid_close' && g5.units[0].metrics.close.reason === 'too_early');

/* ---------------------------------------------------------------- venue lead-lag */
const T0 = Date.parse('2026-11-05T12:00:00Z'), KL = T0 + 600 * 60000;
const ob = (venue, t, v) => ({ venue, market: 'moneyline', at: T0 + t * 60000, value: v, flag: null, raw: {}, source_id: venue + t });
const dkVals = [0.5, 0.5, 0.53, 0.53, 0.53, 0.5, 0.5, 0.5, 0.5, 0.5];
const SA = E.buildSeries(dkVals.map((v, i) => ob('draftkings', i * 60, v)), 'draftkings', 'moneyline', KL, R);
const kv = (t) => (t < 100 ? 0.5 : t < 330 ? 0.53 : t < 400 ? 0.5 : 0.53);
const kts = []; for (let t = 0; t < 600; t += 5) kts.push(t);
const SB = E.buildSeries(kts.map((t) => ob('kalshi', t, kv(t))), 'kalshi', 'moneyline', KL, R);
const LL = E.pairMoves(SA, SB, 0.02, 180, KL);
chk('lead-lag: two pairs and one unmatched move', LL.pairs.length === 2 && LL.unmatched.length === 1, LL);
chk('lead-lag: DraftKings (60,120] vs Kalshi (95,100] overlap: UNRESOLVED, never a forced winner', LL.pairs[0].order === 'UNRESOLVED' && LL.pairs[0].leader === null);
chk('lead-lag: DraftKings (240,300] ends before Kalshi (325,330] begins: DraftKings first observed, lead 25 to 90 minutes',
  LL.pairs[1].order === 'LEADER' && LL.pairs[1].leader === 'draftkings' && LL.pairs[1].lead_minutes.join() === '25,90');
chk('lead-lag: Kalshi\'s up move at (395,400] has no DraftKings follower in a fully covered window: UNMATCHED', LL.unmatched[0].venue === 'kalshi' && LL.unmatched[0].status === 'UNMATCHED');

const SA2 = E.buildSeries([[0, 0.5], [10, 0.53], [20, 0.53], [30, 0.56], [40, 0.56]].map((x) => ob('draftkings', x[0], x[1])), 'draftkings', 'moneyline', T0 + 120 * 60000, R);
const SB2 = E.buildSeries([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60].map((t) => ob('kalshi', t, t < 50 ? 0.5 : 0.53)), 'kalshi', 'moneyline', T0 + 120 * 60000, R);
const LL2 = E.pairMoves(SA2, SB2, 0.02, 180, T0 + 120 * 60000);
chk('lead-lag: no follower move is reused — one pair, the second leader move unmatched', LL2.pairs.length === 1 && LL2.unmatched.length === 1 && LL2.unmatched[0].venue === 'draftkings');
chk('lead-lag: the pair takes the earliest leader move', LL2.pairs[0].a.lo === new Date(T0).toISOString() && LL2.pairs[0].leader === 'draftkings');
const SA3 = E.buildSeries([[0, 0.5], [10, 0.53], [20, 0.53]].map((x) => ob('draftkings', x[0], x[1])), 'draftkings', 'moneyline', T0 + 60 * 60000, R);
const SB3 = E.buildSeries([[0, 0.5], [10, 0.53], [20, 0.53]].map((x) => ob('kalshi', x[0], x[1])), 'kalshi', 'moneyline', T0 + 60 * 60000, R);
chk('lead-lag: identical intervals are a TIE', E.pairMoves(SA3, SB3, 0.02, 180, T0 + 60 * 60000).pairs[0].order === 'TIE');
const SB4 = E.buildSeries([[0, 0.5], [10, 0.53], [11, 0.5], [20, 0.5]].map((x) => ob('kalshi', x[0], x[1])), 'kalshi', 'moneyline', T0 + 60 * 60000, R);
chk('lead-lag: a quote that flickers for one observation is not a move', E.venueMoves(SB4, 0.02).length === 0);
const blocked = E.leadLagForGame({ kickoff: KL }, { 'draftkings:moneyline': SA, 'kalshi:moneyline': SB }, { draftkings: E.venueProfile('draftkings', 'nfl', R), kalshi: E.venueProfile('kalshi', 'nfl', R, null) }, R);
chk('lead-lag: blocked while Kalshi settlement is unverified', blocked.status === 'BLOCKED' && blocked.reason === 'settlement_unverified');
const open = E.leadLagForGame({ kickoff: KL }, { 'draftkings:moneyline': SA, 'kalshi:moneyline': SB }, { draftkings: E.venueProfile('draftkings', 'nfl', R), kalshi: E.venueProfile('kalshi', 'nfl', R, { verified: true, overtime: 'included', tie: 'push' }) }, R);
chk('lead-lag: measured once verified, pairs bucketed by time before start (refs 500 and 300 min before)', open.status === 'MEASURED' && open.pairs[0].bucket === '6-24h' && open.pairs[1].bucket === '1-6h');
const llsum = E.leadLagSummary([{ sport: 'nfl', lead_lag: open }], R);
const llAll = llsum.filter((x) => x.bucket === 'all')[0];
chk('lead-lag summary: one resolved pair, one unresolved, no label below 20 resolved pairs', llAll.resolved === 1 && llAll.unresolved === 1 && llAll.label === null && llAll.label_status === 'INSUFFICIENT_RESOLVED_PAIRS');
const many = { status: 'MEASURED', moves: { a: [], b: [] }, unmatched: [], pairs: [] };
for (let i = 0; i < 22; i++) many.pairs.push({ order: 'LEADER', leader: i < 20 ? 'kalshi' : 'draftkings', lead_minutes: [5, 30], bucket: '1-6h' });
const lab = E.leadLagSummary([{ sport: 'cfb', lead_lag: many }], R).filter((x) => x.bucket === 'all')[0];
chk('lead-lag summary: 20 of 22 resolved pairs (Wilson lower bound 0.72) earns the label, worded as observed precedence', lab.label && lab.label.venue === 'kalshi' && lab.label.text === 'First observed among tracked venues more often' && lab.shares.kalshi.lo > 0.7);

/* ---------------------------------------------------------------- statistics */
const w = E.wilson(7, 10);
chk('Wilson 7/10: [0.3968, 0.8922]', w.lo === 0.3968 && w.hi === 0.8922, w);
chk('Wilson of nothing is nothing', E.wilson(0, 0) === null);
const bs1 = E.bootstrap([[1], [2], [3], [4], [5]], E.mean, 'seed', 500, 0.95), bs2 = E.bootstrap([[1], [2], [3], [4], [5]], E.mean, 'seed', 500, 0.95);
chk('bootstrap is seeded: the same data and seed give the same interval', bs1.lo === bs2.lo && bs1.hi === bs2.hi && bs1.lo < 3 && bs1.hi > 3);
const mk = (i, conv, closer, qual, prec, cls) => ({ status: 'measured', event_id: 'E' + i, horizon_bucket: '6-24h', source: 'edgedesk', model_key: 'syn_s', model_label: 's', model_version: 'v1', sport: 'nfl', market: 'spread', measure: 'line_points', venue: 'draftkings',
  metrics: { material: true, convergence: conv, directional: conv, closer, overshoot: false, cls, horizons: [], baseline: { ok: true }, close: { ok: true },
    move: qual ? { status: 'QUALIFIED', precedence: prec, minutes_from_publication: [10 * i, 10 * i + 60] } : { status: 'NONE' } } });
const su = [mk(1, 1, 'closer', true, 'PRECEDED', 'TOWARD_HELD'), mk(2, 1, 'closer', true, 'PRECEDED', 'TOWARD_HELD'), mk(3, 1, 'closer', true, 'UNRESOLVED', 'TOWARD_HELD'),
  mk(4, 0.5, 'closer', true, 'PRECEDED', 'TOWARD_REVERSED'), mk(5, 0, 'equal', false, null, 'NO_QUALIFYING_MOVE'), mk(6, 0, 'equal', false, null, 'NO_QUALIFYING_MOVE'),
  mk(7, -0.5, 'further', false, null, 'MOVED_AWAY'), mk(8, 2, 'closer', true, 'PRECEDED', 'TOWARD_HELD'), mk(9, 1, 'closer', true, 'UNRESOLVED', 'TOWARD_HELD'), mk(10, -1, 'further', false, null, 'MOVED_AWAY'),
  { status: 'excluded', exclusion_reason: 'no_fresh_baseline', event_id: 'E11', horizon_bucket: '6-24h', source: 'edgedesk', model_key: 'syn_s', model_version: 'v1', sport: 'nfl', market: 'spread', venue: 'draftkings', metrics: { baseline: { ok: false }, close: { ok: true } } }];
const sm = E.summarize(su, R).filter((x) => x.horizon_bucket === 'all')[0];
chk('summary: 11 units, 10 measured, 1 excluded with its reason', sm.units === 11 && sm.measured === 10 && sm.exclusions.no_fresh_baseline === 1);
chk('summary: closes closer 6 of 10 (2 equal), Wilson interval reported', sm.closer.k === 6 && sm.closer.equal === 2 && sm.closer.n === 10 && sm.closer.wilson.p === 0.6);
chk('summary: mean convergence 5/10 = 0.5, median (0.5+1)/2 = 0.75, interval at n = 10', sm.convergence.mean === 0.5 && sm.convergence.median === 0.75 && Array.isArray(sm.convergence.mean_ci));
chk('summary: qualifying 6 of 10; preceded 4, unresolved 2 (explicit denominators)', sm.qualifying.k === 6 && sm.qualifying.n === 10 && sm.precedence.preceded === 4 && sm.precedence.unresolved === 2);
chk('summary: no-move 2/10, reversal 1/6, moved away 2/10 — misses are counted, not dropped', sm.rates.no_move.k === 2 && sm.rates.reversal.k === 1 && sm.rates.reversal.n === 6 && sm.rates.moved_away.k === 2);
chk('summary: time to move reports lower and upper bounds separately (preceded: 10,20,40,80 -> median 30 / 90)', sm.time_to_move.preceded.n === 4 && sm.time_to_move.preceded.median_lower === 30 && sm.time_to_move.preceded.median_upper === 90);
chk('summary: evidence OK at n = 10', sm.evidence === 'OK');
const thin = E.summarize(su.slice(0, 3), R).filter((x) => x.horizon_bucket === 'all')[0];
chk('summary: n = 3 is insufficient evidence and carries no interval', thin.evidence === 'INSUFFICIENT_EVIDENCE' && thin.convergence.mean_ci === null);

/* ---------------------------------------------------------------- the incremental-information check (T3) */
const rows = [];
for (let i = 0; i < 120; i++) {
  const d = ((i * 29) % 9 - 4) / 4, r = ((i * 13) % 7 - 3) / 10, noise = ((i * 37) % 11 - 5) / 50;
  rows.push({ event_id: 'I' + i, kickoff: new Date(T0 + i * H).toISOString(), y: 0.8 * d + 0.1 * r + noise, r, d });
}
const inc = E.incrementalInformation(rows, R, 'test');
chk('incremental: 84 events train, 36 holdout, chronologically', inc.n_train === 84 && inc.n_holdout === 36 && Date.parse(inc.train_through) < Date.parse(inc.holdout_from));
chk('incremental: disagreement adds information when it does (interval above 0, slope ~0.8)', inc.status === 'COMPUTED' && inc.ci[0] > 0 && near(inc.coef_full[2], 0.8, 0.05), inc);
const noInfo = rows.map((x) => Object.assign({}, x, { y: 0.1 * x.r + ((x.d * 1000) % 7) / 1000 }));
const inc0 = E.incrementalInformation(noInfo.map((x, i) => Object.assign({}, x, { y: 0.1 * x.r + (((i * 37) % 11) - 5) / 50 })), R, 'none');
chk('incremental: no information gives no claim', inc0.status === 'COMPUTED' && !(inc0.ci[0] > 0) && /No evidence/.test(inc0.text));
chk('incremental: 40 units is insufficient evidence', E.incrementalInformation(rows.slice(0, 40), R).status === 'INSUFFICIENT_EVIDENCE');

/* ---------------------------------------------------------------- the whole run */
const run1 = E.evaluate({ games: S.GAMES }, M, new Date(NOW).toISOString());
const run2 = E.evaluate({ games: S.GAMES.slice().reverse() }, M, new Date(NOW).toISOString());
chk('deterministic and order-independent: the same records give byte-identical results', JSON.stringify(run1) === JSON.stringify(run2));
chk('unit keys are unique', new Set(run1.units.map((x) => x.unit_key)).size === run1.units.length);
chk('every excluded unit names its reason', run1.units.filter((x) => x.status === 'excluded').every((x) => x.exclusion_reason));
const early = E.evaluate({ games: S.GAMES }, M, new Date(S.K1 - H).toISOString());
chk('no future information: a game not yet kicked off is not evaluated', early.counts.games === 0 && early.counts.pending_games === 5);
const later = JSON.parse(JSON.stringify(S.G1));
later.dk.push(S.sp('SYN_G1', S.K1, 0.5, -9));                       /* an in-game price */
later.forecasts.push(S.col('m9', 'SYN_G1', S.K1, -3, { spread: -20 })); /* a forecast after two evaluation times */
const gL = E.evaluateGame(later, R, NOW);
chk('no future information: an in-game price changes nothing pregame', gL.series['draftkings:spread'].points.length === 8 && gL.units.filter((x) => x.model_key === 'syn_b')[0].metrics.C === -4.5);
chk('no future information: a later forecast never enters an earlier consensus', JSON.stringify(gL.game.consensus.filter((c) => c.offset_minutes === 1440)[0]) === JSON.stringify(g1.game.consensus.filter((c) => c.offset_minutes === 1440)[0]));
chk('summaries never pool sports, markets or venues', run1.summaries.every((s) => s.key.split('|').length === 7));
chk('no composite score anywhere in a summary', run1.summaries.every((s) => !('score' in s) && !('grade' in s) && !('composite' in s)));
chk('a re-run of the same game gives the same input hash (idempotent writes)', E.evaluateGame(S.G1, R, NOW).game.input_hash === g1.game.input_hash);

process.exit(T.done());
