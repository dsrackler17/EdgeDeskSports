#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk UFC — the pipeline's rules, held.

   Everything the Live Fight Center depends on that would fail quietly if it
   drifted: fighter identity, the draw rule, the first-bell boundary, the
   restart and dedup guarantees of the poller, the stale/health thresholds,
   the determinism of the baselines and flags, and the gate window. Driven
   against the in-memory database stand-in (tools/ufc/fake_db.js) and the
   synthetic provider documents (tools/ufc/fixtures/make_card.js); nothing
   here touches the network or the real project.

   Run: node tools/ufc/ufc.test.js
   =========================================================================== */
'use strict';
process.env.UFC_QUIET = '1';
const path = require('path');
const R = require('../../lib/ufc_research.js');
const E = require('./espn.js');
const S = require('./sync_events.js');
const P = require('./live_poll.js');
const B = require('./build_baselines.js');
const G = require('./live_gate.js');
const M = require('./fixtures/make_card.js');
const { fakeDb } = require('./fake_db.js');

let pass = 0, fail = 0; const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 300); } }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
}
function eq(name, got, want) { chk(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }

const FIGHTERS = [
  { fighter_id: 'alexander-volkanovski', full_name: 'Alexander Volkanovski', wins: 26, losses: 4 },
  { fighter_id: 'weili-zhang', full_name: 'Weili Zhang', wins: 25, losses: 3 },
  { fighter_id: 'jon-jones', full_name: 'Jon Jones', wins: 27, losses: 1 },
  { fighter_id: 'jiri-prochazka', full_name: 'Jiří Procházka', wins: 30, losses: 5 },
  { fighter_id: 'jose-aldo', full_name: 'Jose Aldo', wins: 32, losses: 8 },
  { fighter_id: 'chris-smith', full_name: 'Chris Smith', wins: 10, losses: 2 },
  { fighter_id: 'colby-smith', full_name: 'Colby Smith', wins: 8, losses: 3 },
  { fighter_id: 'marco-testerson', full_name: 'Marco Testerson', wins: 15, losses: 3 },
  { fighter_id: 'ivan-sparring', full_name: 'Ivan Sparring', wins: 12, losses: 4 },
  { fighter_id: 'fixture-zhang', full_name: 'Fixture Zhang', wins: 9, losses: 1 },
  { fighter_id: 'alexander-placeholder', full_name: 'Alexander Placeholder', wins: 11, losses: 2 }
];
const IX = R.buildFighterIndex(FIGHTERS);

/* ======================================================================== */
/* 1. FIGHTER IDENTITY                                                      */
/* ======================================================================== */
eq('nickname, suffix and case fold away', R.normName('Jon "Bones" Jones Jr.'), 'jon jones');
eq('accents fold away', R.normName('Jiří Procházka'), 'jiri prochazka');
eq('generational suffix with a dot folds away', R.normName('Jose Aldo Jr.'), 'jose aldo');
eq('exact name resolves', R.resolveFighter('Jon Jones', null, IX, {}).fighter_id, 'jon-jones');
eq('accented feed name resolves to the unaccented row', R.resolveFighter('Jiri Prochazka', null, IX, {}).fighter_id, 'jiri-prochazka');
eq('name order swap resolves (Zhang Weili -> Weili Zhang)', R.resolveFighter('Zhang Weili', null, IX, {}).method, 'name_order');
eq('a short first name resolves on a unique surname (Alex Volkanovski)', R.resolveFighter('Alex Volkanovski', null, IX, {}).fighter_id, 'alexander-volkanovski');
const amb = R.resolveFighter('C. Smith', null, IX, {});
chk('a surname two fighters share with the same initial is NOT a match', amb.fighter_id === null && amb.method === 'ambiguous', JSON.stringify(amb));
eq('an unknown name resolves to nothing, not to a neighbour', R.resolveFighter('Nobody Atall', null, IX, {}).fighter_id, null);
eq('a provider id alias wins over the name', R.resolveFighter('Somebody Else', '99', IX, { 'espn:99': 'jon-jones' }).method, 'provider_id');
eq('a stored name alias resolves', R.resolveFighter('Bones Jones', null, IX, { 'name:bones jones': 'jon-jones' }).fighter_id, 'jon-jones');
chk('a name that does not reach a match keeps the ambiguity visible', R.resolveFighter('Smith', null, IX, {}).fighter_id === null);
const IX2 = R.buildFighterIndex(FIGHTERS.concat([{ fighter_id: 'jose-delgado', full_name: 'Jose Delgado' }, { fighter_id: 'carlos-delgado', full_name: 'Carlos Delgado' }, { fighter_id: 'ana-maria-costa', full_name: 'Ana Maria Costa' }, { fighter_id: 'ana-lima-costa', full_name: 'Ana Lima Costa' }]));
eq('a feed name with a middle name resolves to the unique first+last on file (Jose Miguel Delgado)', R.resolveFighter('Jose Miguel Delgado', null, IX2, {}).fighter_id, 'jose-delgado');
eq('and the method says so', R.resolveFighter('Jose Miguel Delgado', null, IX2, {}).method, 'first_last');
chk('a first+last pair shared by two people on file is refused', R.resolveFighter('Ana Costa', null, IX2, {}).method === 'ambiguous');
chk('a shared surname is still not enough (Chris Smith is not Colby Smith)', R.resolveFighter('C. Smith', null, IX2, {}).fighter_id === null);
eq('the provider\'s TBA placeholder is a placeholder, not a miss', R.resolveFighter('Opponent TBA', '4402367', IX2, {}).method, 'placeholder');
chk('sameName tolerates a middle name and nothing else', R.sameName('Jose Delgado', 'Jose Miguel Delgado') && R.sameName('Jon Jones Jr.', 'Jon Jones') && !R.sameName('Chris Smith', 'Colby Smith') && !R.sameName('Jose Delgado', 'Carlos Delgado'));
const nMid = R.normalizeFixture(R.groupFixtures([{ sig_key: 'm1', event_id: 'oddsM', market: 'h2h', selection: 'Jean Silva', home_team: 'Jean Silva', away_team: 'Jose Delgado', best_dec: 1.5 }, { sig_key: 'm2', event_id: 'oddsM', market: 'h2h', selection: 'Jose Delgado', home_team: 'Jean Silva', away_team: 'Jose Delgado', best_dec: 2.6 }])[0]);
const lMid = R.linkFixture(nMid, [{ bout_id: 'main', event_id: 'e', red_name: 'Jean Silva', blue_name: 'Jose Miguel Delgado' }], null);
chk('a fixture links to a bout whose provider name carries a middle name', lMid.ok && lMid.link.red_sig_key === 'm1' && lMid.link.blue_sig_key === 'm2', JSON.stringify(lMid));

/* ======================================================================== */
/* 2. THE DRAW RULE                                                         */
/* ======================================================================== */
const SIG = [
  { sig_key: 'k1', event_id: 'odds1', market: 'h2h', selection: 'Jean Silva', home_team: 'Jean Silva', away_team: 'Rafa Garcia', commence_time: '2026-09-13T22:00:00Z', best_dec: 1.7, first_best_dec: 1.65, first_seen_at: '2026-09-10T00:00:00Z', last_seen_at: '2026-09-13T20:00:00Z', sharp_fair: 0.6 },
  { sig_key: 'k2', event_id: 'odds1', market: 'h2h', selection: 'Rafa Garcia', home_team: 'Jean Silva', away_team: 'Rafa Garcia', commence_time: '2026-09-13T22:00:00Z', best_dec: 2.3, first_best_dec: 2.4, first_seen_at: '2026-09-10T00:00:00Z', last_seen_at: '2026-09-13T20:00:00Z', sharp_fair: 0.4 },
  { sig_key: 'k3', event_id: 'odds1', market: 'h2h', selection: 'Draw', home_team: 'Jean Silva', away_team: 'Rafa Garcia', commence_time: '2026-09-13T22:00:00Z', best_dec: 41, last_seen_at: '2026-09-13T20:01:00Z' },
  { sig_key: 'k4', event_id: 'odds2', market: 'h2h', selection: 'Draw', home_team: 'Draw', away_team: 'Rafa Garcia', commence_time: '2026-09-13T22:00:00Z', best_dec: 41, last_seen_at: '2026-09-13T20:00:00Z' },
  { sig_key: 'k5', event_id: 'odds3', market: 'h2h', selection: 'Somebody', home_team: 'Jean Silva', away_team: 'Draw', commence_time: '2026-09-13T22:00:00Z', best_dec: 2, last_seen_at: '2026-09-13T20:00:00Z' },
  { sig_key: 'k6', event_id: 'odds1', market: 'totals', selection: 'Over', point: 2.5, home_team: 'Jean Silva', away_team: 'Rafa Garcia', commence_time: '2026-09-13T22:00:00Z', best_dec: 1.9, last_seen_at: '2026-09-13T20:00:00Z' }
];
const fx = R.boutsFromSignals(SIG);
eq('one priced bout comes out of a three-way moneyline', fx.bouts.filter(b => b.priced).length, 1);
const bt = fx.bouts[0];
chk('the two fighters are the fixture participants', bt.a.name === 'Jean Silva' && bt.b.name === 'Rafa Garcia');
chk('the draw price is kept apart from both fighters', bt.draw && bt.draw.sig_key === 'k3' && bt.a.row.sig_key === 'k1' && bt.b.row.sig_key === 'k2');
chk('no fighter slot ever carries a Draw', fx.bouts.every(b => !R.isDrawSelection(b.a.name) && !R.isDrawSelection(b.b.name) && (!b.a.row || !R.isDrawSelection(b.a.row.selection)) && (!b.b.row || !R.isDrawSelection(b.b.row.selection))));
chk('a fixture whose participant IS a draw is rejected with the reason', fx.rejected.some(r => r.signal_event_id === 'odds2' && r.reasons[0].reason === 'draw_as_fighter'));
chk('and so is one with a draw on the other side', fx.rejected.some(r => r.signal_event_id === 'odds3' && r.reasons[0].reason === 'draw_as_fighter'));
chk('a totals market rides with the fixture, not as a fighter', bt.markets.totals && bt.markets.totals.length === 1);
const n1 = R.normalizeFixture(R.groupFixtures(SIG).filter(f => f.signal_event_id === 'odds1')[0]);
const link = R.linkFixture(n1, [{ bout_id: 'b1', event_id: 'e1', red_name: 'Rafa Garcia', blue_name: 'Jean Silva' }], null);
chk('a fixture links to a bout in either corner orientation', link.ok && link.link.red_sig_key === 'k2' && link.link.blue_sig_key === 'k1' && link.link.draw_sig_key === 'k3', JSON.stringify(link));
const link2 = R.linkFixture(n1, [{ bout_id: 'b2', event_id: 'e1', red_name: 'Other Guy', blue_name: 'Jean Silva' }], name => ({ fighter_id: null, method: null }));
chk('a fixture with one unresolved participant is refused, never half-linked', !link2.ok && link2.reason === 'one_fighter_unresolved');
chk('a fixture whose participants resolve but pair no bout is refused', !R.linkFixture(n1, [{ bout_id: 'b3', event_id: 'e1', red_name: 'A B', blue_name: 'C D', red_fighter_id: 'x', blue_fighter_id: 'y' }], name => ({ fighter_id: name === 'Jean Silva' ? 'js' : 'rg', method: 'exact' })).ok);

/* ======================================================================== */
/* 3. THE FIRST BELL                                                        */
/* ======================================================================== */
const BELL = { bout_id: 'b', status: 'live', first_bell_at: '2026-09-14T01:00:00Z' };
eq('12:59:59 is PRE', R.marketStateAt('2026-09-14T00:59:59Z', BELL, null), 'PRE');
eq('1:00:00 (the bell itself) is PRE', R.marketStateAt('2026-09-14T01:00:00Z', BELL, null), 'PRE');
eq('1:00:01 is LIVE', R.marketStateAt('2026-09-14T01:00:01Z', BELL, null), 'LIVE');
eq('a started bout with no observed bell and no card start is LIVE (the safe direction)', R.marketStateAt('2026-09-14T00:00:00Z', { status: 'live' }, null), 'LIVE');
eq('a started bout with no observed bell falls back to the card start', R.marketStateAt('2026-09-13T21:00:00Z', { status: 'live' }, { scheduled_at: '2026-09-13T22:00:00Z' }), 'PRE');
eq('a scheduled bout is PRE', R.marketStateAt('2026-09-14T00:00:00Z', { status: 'scheduled' }, null), 'PRE');
const caps = [
  { at: '2026-09-14T00:30:00Z', sharp_fair: 0.50, best_dec: 2.0, market_state: 'PRE' },
  { at: '2026-09-14T00:59:59Z', sharp_fair: 0.55, best_dec: 1.8, market_state: 'PRE' },
  { at: '2026-09-14T01:00:01Z', sharp_fair: 0.80, best_dec: 1.2, market_state: 'LIVE' },
  { at: '2026-09-14T01:03:00Z', sharp_fair: 0.90, best_dec: 1.1 }
];
const cr = R.closingReference(caps, BELL, null);
chk('the close is the last pre-bell capture, never a post-bell tick', cr.available && cr.fair === 0.55 && cr.at === '2026-09-14T00:59:59.000Z', JSON.stringify(cr));
chk('a post-bell tick with a better fair line is ignored even without a state tag', cr.fair !== 0.9);
const far = R.closingReference([{ at: '2026-09-13T12:00:00Z', sharp_fair: 0.5 }], BELL, null);
chk('a capture seven hours before the bell is not called a close', !far.available && /too far/.test(far.reason));
const none = R.closingReference(caps, { status: 'live' }, null);
chk('no observed bell and no card start means "closing line unavailable"', !none.available && /first bell/.test(none.reason));
chk('CLV needs a real entry and a real close', R.clv(2.0, 0.55) > 0 && R.clv(null, 0.55) === null && R.clv(2.0, null) === null);

/* ======================================================================== */
/* 4. HEALTH THRESHOLDS                                                     */
/* ======================================================================== */
eq('live feed 30s old during a card is HEALTHY', R.healthLevel({ phase: 'live', liveAgeS: 30, marketAgeS: 60, eventAgeS: 600, historyAgeS: 3600 }).level, 'HEALTHY');
eq('live feed 100s old during a card is LIVE DEGRADED', R.healthLevel({ phase: 'live', liveAgeS: 100, marketAgeS: 60, eventAgeS: 600, historyAgeS: 3600 }).level, 'LIVE DEGRADED');
eq('live feed 200s old during a card is STALE', R.healthLevel({ phase: 'live', liveAgeS: 200, marketAgeS: 60, eventAgeS: 600, historyAgeS: 3600 }).level, 'STALE');
eq('no heartbeat ever during a card is OFFLINE', R.healthLevel({ phase: 'live', liveAgeS: null, marketAgeS: 60, eventAgeS: 600, historyAgeS: 3600 }).level, 'OFFLINE');
eq('a poller 20 days old is never "operational" when a card is in its window', R.healthLevel({ phase: 'window', liveAgeS: 20 * 86400, marketAgeS: 60, eventAgeS: 600, historyAgeS: 3600 }).level === 'HEALTHY', false);
eq('an unreadable market during a card is MARKET DEGRADED', R.healthLevel({ phase: 'live', liveAgeS: 10, marketOk: false, marketAgeS: null, eventAgeS: 600, historyAgeS: 3600 }).level, 'MARKET DEGRADED');
eq('between cards, an old event sync is STALE', R.healthLevel({ phase: 'idle', liveAgeS: null, marketAgeS: null, eventAgeS: 40 * 3600, historyAgeS: 3600 }).level, 'STALE');
eq('between cards with fresh sync and history, a silent live feed is fine', R.healthLevel({ phase: 'idle', liveAgeS: 5 * 86400, marketAgeS: null, eventAgeS: 3600, historyAgeS: 86400 }).level, 'HEALTHY');
eq('three consecutive source failures degrade a live card', R.healthLevel({ phase: 'live', liveAgeS: 10, marketAgeS: 60, eventAgeS: 600, historyAgeS: 3600, consecutiveFailures: 3 }).level, 'LIVE DEGRADED');
eq('age labels are readable', R.ageLabel(134), '2m 14s ago');

/* ======================================================================== */
/* 5. BASELINES — deterministic, sampled, honest about gaps                */
/* ======================================================================== */
const NOW = Date.parse('2026-09-09T00:00:00Z');
const fights = [
  { fighter_id: 'jon-jones', opponent_id: 'jose-aldo', date: '2026-03-01', winner: 'jon-jones', method: 'KO/TKO', round: 2, time: '3:10', title_fight: true },
  { fighter_id: 'jon-jones', opponent_id: 'jiri-prochazka', date: '2025-09-01', winner: 'jon-jones', method: 'Decision - Unanimous', round: 5, time: '5:00', title_fight: true },
  { fighter_id: 'jon-jones', opponent_id: 'weili-zhang', date: '2025-03-01', winner: 'weili-zhang', method: 'Submission', round: 1, time: '4:00' },
  { fighter_id: 'jon-jones', opponent_id: 'chris-smith', date: '2024-09-01', winner: 'jon-jones', method: 'Decision - Split', round: 3, time: '5:00' },
  { fighter_id: 'jon-jones', opponent_id: 'colby-smith', date: '2024-03-01', winner: 'jon-jones', method: 'KO/TKO', round: 4, time: '1:30', title_fight: true },
  { fighter_id: 'jon-jones', opponent_id: 'alexander-volkanovski', date: '2023-09-01', winner: 'draw', method: 'Decision - Majority', round: 3, time: '5:00' }
];
const byId = {}; FIGHTERS.forEach(f => { byId[f.fighter_id] = f; });
const career = { fighter_id: 'jon-jones', slpm: 4.3, sapm: 2.2, striking_accuracy: 57, striking_defense: 0.64, takedown_avg: 1.93, takedown_accuracy: 0.45, takedown_defense: 0.95, submission_avg: 0.5, knockdown_avg: 0.3 };
const b1 = R.buildBaseline({ fighter: byId['jon-jones'], fights, career, byId, now: NOW });
const b2 = R.buildBaseline({ fighter: byId['jon-jones'], fights: fights.slice().reverse(), career, byId, now: NOW });
chk('the baseline is deterministic and order-independent', JSON.stringify(b1) === JSON.stringify(b2));
eq('wins / losses / draws are counted', [b1.wins, b1.losses, b1.draws], [4, 1, 1]);
eq('finish environment is split by method', [b1.win_ko, b1.win_sub, b1.win_dec, b1.loss_sub], [2, 0, 2, 1]);
eq('finish rate is finishes over wins', b1.finish_rate, 0.5);
eq('the current streak counts back from the latest fight', b1.current_streak, 2);
eq('a 57 stored as a percent is normalised to a share', b1.striking_accuracy, 0.57);
eq('layoff is measured from the latest dated fight', b1.days_since_last_fight, Math.floor((NOW - Date.parse('2026-03-01')) / 86400000));
eq('fights in the last 365 / 730 days', [b1.fights_last_365, b1.fights_last_730], [1, 3]);
eq('five-round depth: fights past R3 and finishes after R3', [b1.fights_past_r3, b1.finishes_after_r3], [2, 1]);
eq('R4-5 seconds only count time beyond round 3', b1.r4_r5_seconds, 600 + 90);
eq('round finish distribution', b1.round_finish_dist, { '2': 1, '1': 1, '4': 1 });
eq('opponent quality has a sample', b1.opp_sample, 6);
chk('opponent-weighted win% is computed only with five or more opponents', b1.opp_adj_win_pct != null);
chk('a fighter with two opponents on file gets no opponent-weighted figure', R.buildBaseline({ fighter: byId['jon-jones'], fights: fights.slice(0, 2), career, byId, now: NOW }).opp_adj_win_pct === null);
chk('notes name the gaps honestly', b1.notes.indexOf('no_observed_live_baseline') >= 0 && b1.notes.indexOf('no_career_stats') < 0);
const empty = R.buildBaseline({ fighter: { fighter_id: 'nobody', full_name: 'No Body' }, fights: [], career: null, byId, now: NOW });
chk('a debutant has null rates, not zeros', empty.finish_rate === null && empty.avg_fight_seconds === null && empty.slpm === null && empty.notes.indexOf('debut_or_no_history') >= 0);
chk('style labels come from documented rules with a version', b1.style_rules_version === R.STYLE_RULES.version && R.STYLE_RULES.rules.every(r => r.label && r.means && r.needs && typeof r.test === 'function'));
chk('COUNTER fires on defense + low absorption', R.styleLabels({ slpm: 3.5, sapm: 2.5, striking_defense: 0.6, wins: 0, losses: 0 }).indexOf('COUNTER') >= 0);
chk('FINISH-HEAVY needs five wins', R.styleLabels({ wins: 4, finish_rate: 1 }).indexOf('FINISH-HEAVY') < 0 && R.styleLabels({ wins: 5, finish_rate: 0.8 }).indexOf('FINISH-HEAVY') >= 0);
eq('style collision', R.styleCollision({ style_labels: ['STRIKER', 'HIGH PACE'] }, { style_labels: ['WRESTLER', 'LOW PACE'] }), ['STRIKER vs WRESTLER', 'HIGH PACE vs LOW PACE']);
const rowsA = B.buildAll({ fighters: FIGHTERS, careers: [career], fights, now: NOW });
const rowsB = B.buildAll({ fighters: FIGHTERS.slice().reverse(), careers: [career], fights: fights.slice().reverse(), now: NOW });
chk('buildAll is deterministic across input order', JSON.stringify(rowsA) === JSON.stringify(rowsB) && rowsA.length === FIGHTERS.length);
const obs = R.observedBaseline([{ state: { sig_strikes_attempted: 100, sig_strikes_landed: 50, takedowns_attempted: 4, head_strikes_landed: 30, body_strikes_landed: 15, leg_strikes_landed: 5, distance_strikes_landed: 40, clinch_strikes_landed: 5, ground_strikes_landed: 5 }, oppState: { sig_strikes_landed: 40 }, elapsed: 900, rounds: [{ round: 1, round_seconds: 300, sig_strikes_attempted: 40 }] }]);
chk('observed baselines carry their sample', obs.fights === 1 && Math.abs(obs.obs_sig_attempts_per_min - 100 / 15) < 1e-9 && obs.obs_body_share === 0.3 && obs.obs_round_pace['1'].n === 1);

/* ======================================================================== */
/* 6. LIVE RATES, FLAGS, READ — with missing data                          */
/* ======================================================================== */
const redState = { sig_strikes_landed: 60, sig_strikes_attempted: 100, takedowns_landed: 1, takedowns_attempted: 5, control_seconds: 150, ground_strikes_landed: 3, head_strikes_landed: 30, body_strikes_landed: 20, leg_strikes_landed: 10, distance_strikes_landed: 20, clinch_strikes_landed: 20, ground_strikes_landed: 3, knockdowns: 1 };
const blueState = { sig_strikes_landed: 30, sig_strikes_attempted: 80, takedowns_landed: 0, takedowns_attempted: 0, control_seconds: 10 };
const redBase = Object.assign({}, b1, { career_stats_available: true, slpm: 4.0, sapm: 2.5, striking_accuracy: 0.4, takedown_avg: 1.0, takedown_accuracy: 0.5, obs_fights: 3, obs_body_share: 0.1, obs_distance_share: 0.7, obs_round_pace: { '1': { n: 3, sig_attempts_per_min: 12 }, '3': { n: 3, sig_attempts_per_min: 11 } } });
const ctx = { bout: { bout_id: 'b', red_name: 'Red Tester', blue_name: 'Blue Tester', round: 3, status: 'live', scheduled_rounds: 3 }, red: redState, blue: blueState, redBase, blueBase: null, elapsed: 600,
  rounds: [{ corner: 'red', round: 1, round_seconds: 300, sig_strikes_attempted: 60, round_status: 'complete' }, { corner: 'red', round: 2, round_seconds: 300, sig_strikes_attempted: 30, round_status: 'complete' }, { corner: 'red', round: 3, round_seconds: 120, sig_strikes_attempted: 10, round_status: 'in_progress' }] };
const rates = R.liveRates(redState, blueState, 600, redBase);
chk('rates are counts over elapsed time', Math.abs(rates.sigLandedPerMin - 6) < 1e-9 && Math.abs(rates.tdAttemptsPer15 - 7.5) < 1e-9 && rates.accuracy === 0.6);
chk('comparisons are against the baseline with kind and sample', rates.vs.sigLandedPerMin.pct === 0.5 && rates.vs.body.kind === 'observed' && rates.vs.body.n === 3);
const bRates = R.liveRates(blueState, redState, 600, null);
chk('a missing fighter has NO comparisons — not zeros', Object.keys(bRates.vs).length === 0 && bRates.target === null && bRates.sigLandedPerMin === 3);
const flags = R.flagsFor(ctx);
const codes = flags.map(f => f.code);
chk('PACE_SPIKE fires at +50% vs career', codes.indexOf('PACE_SPIKE') >= 0);
chk('WRESTLING_SHIFT fires on 5 attempts against a 1.0/15 career rate', codes.indexOf('WRESTLING_SHIFT') >= 0);
chk('FAILED_WRESTLING_LOAD fires on 1 of 5', codes.indexOf('FAILED_WRESTLING_LOAD') >= 0);
chk('TARGET_SHIFT fires on body 33% vs 10% observed over 3 fights', codes.indexOf('TARGET_SHIFT') >= 0);
chk('RANGE_SHIFT fires on 47% distance vs 70% observed', codes.indexOf('RANGE_SHIFT') >= 0);
chk('CONTROL_WITHOUT_DAMAGE fires on 2:30 control with 3 ground strikes', codes.indexOf('CONTROL_WITHOUT_DAMAGE') >= 0);
chk('ROUND_PACE_DECLINE fires on 12 -> 5 attempts/min', codes.indexOf('ROUND_PACE_DECLINE') >= 0);
chk('UNUSUAL_ACCURACY fires on 60% vs 40% career', codes.indexOf('UNUSUAL_ACCURACY') >= 0);
chk('KNOCKDOWN is reported as data', codes.indexOf('KNOCKDOWN') >= 0);
chk('every flag names calculation, baseline, sample and threshold', flags.every(f => f.explain && f.threshold && f.rules === R.FLAG_RULES.version && 'current' in f && 'baseline' in f));
chk('no blue flag compares to a baseline blue does not have', flags.filter(f => f.corner === 'blue').every(f => f.code === 'KNOCKDOWN' || f.code === 'CONTROL_WITHOUT_DAMAGE' || f.code === 'FAILED_WRESTLING_LOAD' || f.code === 'ROUND_PACE_DECLINE'));
chk('no rate flag before two minutes', R.flagsFor(Object.assign({}, ctx, { elapsed: 60 })).every(f => f.code === 'KNOCKDOWN'));
chk('a +10% pace is not a spike', R.flagsFor({ bout: ctx.bout, red: { sig_strikes_landed: 44, sig_strikes_attempted: 90 }, blue: {}, redBase: Object.assign({}, redBase, { obs_fights: 0 }), elapsed: 600, rounds: [] }).every(f => f.code !== 'PACE_SPIKE'));
chk('flags do not use tout language', !/\b(bet|lock|hammer|pick)\b/i.test(JSON.stringify(flags)));
const read = R.liveRead(ctx);
chk('the live read has fight shape, pace, control and unknowns', ['Fight shape', 'Pace', 'Control', 'Unknown'].every(k => read.lines.some(l => l.k === k)));
chk('the live read says a missing fighter has no history rather than inventing one', read.lines.filter(l => l.k === 'Unknown')[0].v.indexOf('Blue Tester has no history on file') >= 0 || read.lines.filter(l => l.k === 'Unknown')[0].v.indexOf('Tester has no history on file') >= 0);
const partial = E.normalizeStats({ splits: { categories: [{ name: 'significantStrikes', stats: [{ name: 'sigStrikesLanded', value: 12, displayValue: '12' }] }] } });
chk('a partial payload yields only what it carries', partial.stats.sig_strikes_landed === 12 && partial.stats.takedowns_landed === undefined && partial.mapped === 1);
chk('a partial state does not crash the read, the flags or the unknowns', () => { const c = { bout: ctx.bout, red: partial.stats, blue: {}, redBase, blueBase: null, elapsed: 300, rounds: [] }; R.liveRead(c); R.flagsFor(c); R.unknowns({ bout: ctx.bout, redBase, blueBase: null, live: { missing: R.missingLiveFields(partial.stats, {}) } }); return true; });
eq('missing live fields are named', R.missingLiveFields(partial.stats, {}).indexOf('takedowns') >= 0, true);
const unk = R.unknowns({ bout: ctx.bout, redBase: b1, blueBase: null, market: { linked: false } });
chk('unknowns: no history, opponent-quality, five-round, observed baseline, no market', ['No history on file', 'No observed target or range baseline', 'No market on file'].every(k => unk.some(u => u.k === k)));
const mrows = R.matchupRows(ctx.bout, { reach_inches: 76 }, {}, b1, null);
chk('matchup rows leave a missing fighter null, never zero', mrows.filter(r => r.label === 'Reach')[0].blue === null && mrows.filter(r => r.label === 'Sig. strikes landed / min')[0].blue === null);
const leans = R.roundLean([{ round: 1, corner: 'red', sig_strikes_landed: 20, knockdowns: 0 }, { round: 1, corner: 'blue', sig_strikes_landed: 10, knockdowns: 1 }]);
chk('the statistical lean weights a knockdown above strikes and states its basis', leans[0].corner === 'blue' && leans[0].basis.indexOf('knockdowns blue') >= 0);
eq('elapsed time counts down inside a round', R.elapsedFromClock(3, 161), 600 + 139);
eq('a decision ran the distance', R.elapsedAtEnd({ method: 'Decision - Unanimous', scheduled_rounds: 5 }), 1500);
eq('a stoppage ends at its time into the round', R.elapsedAtEnd({ method: 'KO/TKO', end_round: 2, end_time: '3:15' }), 495);

/* ======================================================================== */
/* 7. MARKET SUMMARY                                                        */
/* ======================================================================== */
const ms = R.marketSummary(SIG[0], SIG[1], SIG[2]);
chk('de-vig removes the margin', Math.abs(ms.devig.red + ms.devig.blue - 1) < 1e-9 && ms.devig.vig > 0);
chk('movement is reported in American and probability terms', ms.red.movement.openAm === -154 && ms.red.movement.nowAm === -143 && Math.abs(ms.red.movement.pp - (1 / 1.7 - 1 / 1.65) * 100) < 1e-9);
chk('the draw is a separate column', ms.draw && ms.draw.selection === 'Draw');

/* ======================================================================== */
/* 8. ESPN PARSING                                                          */
/* ======================================================================== */
const card = M.card({ bouts: [
  { id: '1', order: 3, red: { id: 'a', name: 'Marco Testerson' }, blue: { id: 'b', name: 'Ivan Sparring' }, rounds: 5, title: true, status: 'pre' },
  { id: '2', order: 2, red: { id: 'c', name: 'Zhang Fixture' }, blue: { id: 'd', name: 'Alex Placeholder' }, status: 'live', round: 2, clock: '1:07' },
  { id: '3', order: 1, red: { id: 'e', name: 'Some Body' }, blue: { id: 'f', name: 'Any One' }, status: 'final', method: 'Submission', methodDetail: 'Rear naked choke', winner: 'blue', round: 1, endTime: '2:20' },
  { id: '4', order: 0, red: { id: 'g', name: 'Can Celled' }, blue: { id: 'h', name: 'Not Happening' }, status: 'cancelled' }
] });
const ev = E.parseScoreboard(card)[0];
eq('the event is live when a bout is live', ev.event_state, 'live');
eq('statuses map', ev.bouts.map(b => b.status), ['scheduled', 'live', 'final', 'cancelled']);
chk('corners follow the provider order and ids ride along', ev.bouts[0].red_name === 'Marco Testerson' && ev.bouts[0].red_provider_id === 'a' && ev.bouts[0].corner_source === 'provider_order');
chk('title, rounds, order and main are read', ev.bouts[0].is_title && ev.bouts[0].scheduled_rounds === 5 && ev.bouts[0].bout_order === 3 && ev.bouts[0].is_main);
chk('a live bout carries round and clock', ev.bouts[1].round === 2 && ev.bouts[1].clock === '1:07');
chk('a final bout carries winner, method, detail, end round and time', ev.bouts[2].winner_corner === 'blue' && ev.bouts[2].method === 'Submission' && ev.bouts[2].method_detail === 'Rear naked choke' && ev.bouts[2].end_round === 1 && ev.bouts[2].end_time === '2:20');
chk('a scheduled bout carries no result', ev.bouts[0].winner_corner === null && ev.bouts[0].method === null);
const st = E.normalizeStats(M.statsDoc({ sigL: 52, sigA: 110, headL: 30, headA: 70, ctrl: 161, tdL: 2, tdA: 6, kd: 1 }));
chk('the stats normaliser reads flat values, composites and clocks', st.stats.sig_strikes_landed === 52 && st.stats.sig_strikes_attempted === 110 && st.stats.head_strikes_landed === 30 && st.stats.head_strikes_attempted === 70 && st.stats.control_seconds === 161 && st.stats.takedowns_attempted === 6 && st.stats.knockdowns === 1);
chk('percentages are ignored, unknown keys are counted', st.unmapped.sigstrikespct === undefined && E.normalizeStats({ stats: [{ name: 'mysteryStat', value: 3 }] }).unmapped.mysterystat === 1);
const rs = E.roundSplits(M.statsDoc({ sigL: 30 }, { 1: { sigL: 10 }, 2: { sigL: 20 } }));
chk('provider round splits are read when present', rs[1] && rs[1].sig_strikes_landed === 10 && rs[2].sig_strikes_landed === 20);

/* ======================================================================== */
/* 8b. DISCOVERY — the request shapes, and what a 403 does to them          */
/* ======================================================================== */
(async () => {
  const doc = M.card({ bouts: [{ id: '9', order: 1, red: { id: 'a', name: 'Marco Testerson' }, blue: { id: 'b', name: 'Ivan Sparring' } }] });
  const far = M.card({ eventId: '600099002', date: '2026-12-13T22:00Z', bouts: [{ id: '8', order: 1, red: { id: 'c', name: 'Some Body' }, blue: { id: 'd', name: 'Any One' } }] });
  const seen = [];
  const f403range = async (url, opts) => {
    seen.push({ url, headers: opts.headers || {} });
    if (/dates=\d{8}-\d{8}/.test(url)) return { ok: false, status: 403, text: async () => 'forbidden' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ events: doc.events.concat(far.events) }) };
  };
  const src = E.source({ fetchImpl: f403range });
  const r = await src.scoreboard(Date.parse('2026-09-06T00:00:00Z'), Date.parse('2026-10-09T00:00:00Z'));
  chk('a 403 on the range falls through to the year request', r.via === 'year:2026' && r.tried.length === 2 && r.tried[0].status === 403, JSON.stringify(r.tried));
  chk('the answer is filtered to the window and says how many it saw', r.events.length === 1 && r.totalSeen === 2 && r.events[0].provider_event_id === '600099001');
  chk('no custom User-Agent is sent — the plain request the football jobs make', seen.every(x => !Object.keys(x.headers).some(h => h.toLowerCase() === 'user-agent')) && seen.every(x => x.headers.accept === 'application/json'));
  chk('the request shapes are range, year, plain, in that order', E.discoveryAttempts(Date.parse('2026-09-06T00:00:00Z'), Date.parse('2026-10-09T00:00:00Z')).map(a => a.via).join(',') === 'range,year:2026,plain');
  chk('a window crossing a year boundary asks for both years', E.discoveryAttempts(Date.parse('2026-12-20T00:00:00Z'), Date.parse('2027-01-20T00:00:00Z')).map(a => a.via).join(',') === 'range,year:2026,year:2027,plain');
  const probe = await src.probe(Date.parse('2026-09-06T00:00:00Z'), Date.parse('2026-10-09T00:00:00Z'));
  chk('the probe reports every shape with its status', probe.length === 3 && probe[0].status === 403 && probe[1].status === 200 && probe[1].inWindow === 1 && probe[2].status === 200);
  let allFail = null;
  try { await E.source({ fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'no' }) }).scoreboard(Date.parse('2026-09-06T00:00:00Z'), Date.parse('2026-10-09T00:00:00Z')); }
  catch (e) { allFail = e; }
  chk('every shape failing is one error that lists each status', allFail && /range -> 403; year:2026 -> 403; plain -> 403/.test(allFail.message), allFail && allFail.message);
  chk('an undated card is never silently dropped by the window filter', E.inWindow({ scheduled_at: null }, 0, 1));
})().catch(e => { chk('discovery tests ran', false, String(e && e.stack || e)); });

/* ======================================================================== */
/* 9. THE SYNC — twice, reordered, with a cancelled bout                    */
/* ======================================================================== */
function bouts(o) { o = o || {}; return [
  { id: '401900101', order: o.o1 != null ? o.o1 : 3, red: { id: '5000001', name: 'Marco Testerson' }, blue: { id: '5000002', name: 'Ivan Sparring' }, rounds: 5, title: true, status: o.s1 || 'pre', round: o.r1, clock: o.c1, method: o.m1, winner: o.w1, endTime: o.e1 },
  { id: '401900102', order: o.o2 != null ? o.o2 : 2, red: { id: '5000003', name: 'Zhang Fixture' }, blue: { id: '5000004', name: 'Alex Placeholder' }, rounds: 3, status: o.s2 || 'pre', round: o.r2, clock: o.c2, method: o.m2, winner: o.w2, endTime: o.e2 },
  { id: '401900103', order: o.o3 != null ? o.o3 : 1, red: { id: '5000005', name: 'Jon "Sample" Dummy Jr.' }, blue: { id: '5000006', name: 'Jiří Mockovský' }, rounds: 3, status: o.s3 || 'pre' }
].filter(b => !(o.drop || []).includes(b.id)); }
function seedDb() { return fakeDb({ 'ufc.fighters': FIGHTERS, 'public.signals': SIG.map(r => Object.assign({}, r, { sport_key: 'mma_mixed_martial_arts' })) }); }
async function syncWith(db, doc, now, extra) {
  const src = { async scoreboard() { return { events: E.parseScoreboard(doc), latency: 1 }; } };
  return S.run(Object.assign({ commit: true, market: true, ticks: false, stale: true, now, fromDays: 3, toDays: 30 }, extra || {}), { db, source: src });
}
(async () => {
  const db = seedDb();
  const s1 = await syncWith(db, M.card({ bouts: bouts() }), '2026-09-13T10:00:00Z');
  eq('the sync stores the event and its bouts', [db.count('ufc', 'events'), db.count('ufc', 'bouts')], [1, 3]);
  chk('bouts resolved to both fighters where the dataset has them', s1.resolved === 2 && db.rows('ufc', 'bouts').filter(b => b.bout_id === 'espn:401900101')[0].red_fighter_id === 'marco-testerson');
  chk('unresolved names are reported, not guessed', s1.unmatched.length === 2 && db.rows('ufc', 'bouts').filter(b => b.bout_id === 'espn:401900103')[0].red_fighter_id === null);
  /* a database whose migration predates the first_last confidence value */
  const dbOld = seedDb();
  const origUpsert = dbOld.upsert.bind(dbOld);
  dbOld.upsert = async (schema, rel, rows, onConflict, o) => {
    if (rel === 'fighter_aliases' && rows.some(r => !S.ORIGINAL_CONFIDENCE.includes(r.confidence))) { const e = new Error('UPSERT ufc.fighter_aliases -> 400: {"code":"23514","message":"new row for relation \\"fighter_aliases\\" violates check constraint"}'); e.status = 400; throw e; }
    return origUpsert(schema, rel, rows, onConflict, o);
  };
  dbOld.tables['ufc.fighters'].push({ fighter_id: 'jose-delgado', full_name: 'Jose Delgado' });
  const sOld = await syncWith(dbOld, M.card({ bouts: [{ id: '401900110', order: 1, red: { id: '5000001', name: 'Marco Testerson' }, blue: { id: '5223435', name: 'Jose Miguel Delgado' } }] }), '2026-09-13T10:00:00Z', { market: false });
  chk('an alias the older constraint refuses does not end the sync: the bout is still resolved and written', sOld.resolved === 1 && dbOld.rows('ufc', 'bouts')[0].blue_fighter_id === 'jose-delgado', JSON.stringify(sOld.errors));
  chk('and the run says the migration needs re-running', sOld.errors.some(e => /schema lag/.test(e) && /first_last/.test(e)));
  chk('rows the older constraint accepts are still written', dbOld.rows('ufc', 'fighter_aliases').every(a => S.ORIGINAL_CONFIDENCE.includes(a.confidence)));
  const dbT = seedDb();
  const sT = await syncWith(dbT, M.card({ bouts: [{ id: '401900109', order: 1, red: { id: '5000001', name: 'Marco Testerson' }, blue: { id: '4402367', name: 'Opponent TBA' } }] }), '2026-09-13T10:00:00Z', { market: false });
  chk('a TBA opponent is stored as the provider names it and is not listed as unresolved', sT.unmatched.length === 0 && dbT.rows('ufc', 'bouts')[0].blue_name === 'Opponent TBA' && dbT.rows('ufc', 'bouts')[0].blue_fighter_id === null);
  chk('a surname resolution earns a provider-id alias', db.rows('ufc', 'fighter_aliases').some(a => a.alias_key === 'espn:5000004' && a.fighter_id === 'alexander-placeholder'));
  const s2 = await syncWith(db, M.card({ bouts: bouts() }), '2026-09-13T16:00:00Z');
  eq('the same card twice is the same rows', [db.count('ufc', 'events'), db.count('ufc', 'bouts'), db.count('ufc', 'bout_markets')], [1, 3, 0]);
  chk('the second run resolves through the stored provider-id alias', s2.resolved === 2);
  const s3 = await syncWith(db, M.card({ bouts: bouts({ o1: 3, o2: 1, o3: 2 }) }), '2026-09-13T18:00:00Z');
  const b2 = db.rows('ufc', 'bouts').filter(b => b.bout_id === 'espn:401900102')[0];
  chk('a reordered card updates bout_order in place, same ids, no duplicates', b2.bout_order === 1 && db.count('ufc', 'bouts') === 3 && s3.bouts === 3);
  const s4 = await syncWith(db, M.card({ bouts: bouts({ drop: ['401900103'] }) }), '2026-09-13T19:00:00Z');
  const b3 = db.rows('ufc', 'bouts').filter(b => b.bout_id === 'espn:401900103')[0];
  chk('a bout that left the card is cancelled in place, never deleted', b3.status === 'cancelled' && b3.status_detail === 'absent from provider card' && s4.cancelled === 1 && db.count('ufc', 'bouts') === 3);
  /* market linking on a card whose fighters match the odds feed */
  const db2 = fakeDb({ 'ufc.fighters': FIGHTERS, 'public.signals': [
    Object.assign({}, SIG[0], { sport_key: 'mma_mixed_martial_arts', home_team: 'Marco Testerson', away_team: 'Ivan Sparring', selection: 'Marco Testerson' }),
    Object.assign({}, SIG[1], { sport_key: 'mma_mixed_martial_arts', home_team: 'Marco Testerson', away_team: 'Ivan Sparring', selection: 'Ivan Sparring' }),
    Object.assign({}, SIG[2], { sport_key: 'mma_mixed_martial_arts', home_team: 'Marco Testerson', away_team: 'Ivan Sparring' }),
    Object.assign({}, SIG[3], { sport_key: 'mma_mixed_martial_arts' })] });
  const s5 = await syncWith(db2, M.card({ bouts: bouts() }), '2026-09-13T10:00:00Z');
  const lk = db2.rows('ufc', 'bout_markets')[0];
  chk('the linker links the fixture to the bout with corners and a separate draw key', s5.links === 1 && lk && lk.bout_id === 'espn:401900101' && lk.red_sig_key === 'k1' && lk.blue_sig_key === 'k2' && lk.draw_sig_key === 'k3');
  chk('the draw-as-fighter fixture is quarantined with its reason', db2.rows('ufc', 'market_rejections').some(r => r.reason === 'draw_as_fighter' && r.home_team === 'Draw'));
  chk('pre-fight captures are written PRE with openers (the draw row has no opener)', db2.rows('ufc', 'market_captures').length === 5 && db2.rows('ufc', 'market_captures').every(c => c.market_state === 'PRE') && db2.rows('ufc', 'market_captures').filter(c => c.source === 'signals_open').length === 2);
  await syncWith(db2, M.card({ bouts: bouts() }), '2026-09-13T11:00:00Z');
  chk('captures are not duplicated on a second run', db2.count('ufc', 'market_captures') === 5);
  const rj = db2.rows('ufc', 'market_rejections').filter(r => r.reason === 'draw_as_fighter')[0];
  chk('a repeated rejection counts up instead of duplicating', rj.seen_count === 2 && db2.rows('ufc', 'market_rejections').filter(r => r.reason === 'draw_as_fighter').length === 1);
  /* stale */
  const db3 = fakeDb({ 'ufc.fighters': FIGHTERS, 'ufc.events': [{ event_id: 'espn:old', provider_event_id: 'old', event_state: 'live', scheduled_at: '2026-08-20T22:00:00Z' }] });
  await syncWith(db3, M.card({ bouts: bouts() }), '2026-09-13T10:00:00Z', { market: false });
  chk('an event 20 days past its start and still open is marked stale', db3.rows('ufc', 'events').filter(e => e.event_id === 'espn:old')[0].event_state === 'stale');
  eq('staleEvents leaves a card inside its window alone', S.staleEvents([{ event_id: 'x', event_state: 'live', scheduled_at: '2026-09-13T04:00:00Z' }], Date.parse('2026-09-13T10:00:00Z')), []);
  const v = await S.run({ verify: true, fixture: path.join(__dirname, 'fixtures', 'scoreboard_sample.json'), now: '2026-09-13T10:00:00Z', fromDays: 3, toDays: 30 }, {});
  chk('--verify reads a recorded scoreboard without a database', v.events === 1 && v.bouts === 3);

  /* ====================================================================== */
  /* 10. THE POLLER — bell, rounds, restart, dedup, cancelled, lock, hand-off */
  /* ====================================================================== */
  const db4 = seedDb();
  await syncWith(db4, M.card({ bouts: bouts() }), '2026-09-13T21:00:00Z', { market: false });
  let step = 0;
  const docs = [
    M.card({ bouts: bouts() }),
    M.card({ bouts: bouts({ s2: 'live', r2: 1, c2: '3:00' }) }),
    M.card({ bouts: bouts({ s2: 'live', r2: 2, c2: '4:00' }) }),
    M.card({ bouts: bouts({ s2: 'live', r2: 2, c2: '1:00', drop: ['401900103'] }) }),
    M.card({ bouts: bouts({ s2: 'final', r2: 3, m2: 'Decision - Unanimous', w2: 'blue', e2: '5:00', drop: ['401900103'] }) }),
    M.card({ bouts: bouts({ s2: 'final', r2: 3, m2: 'Decision - Unanimous', w2: 'blue', e2: '5:00', s1: 'final', r1: 1, m1: 'KO/TKO', w1: 'red', e1: '2:00', drop: ['401900103'] }) })
  ];
  const statsAt = [
    {},
    { '5000003': { sigL: 10, sigA: 20, tdA: 2, tdL: 1, ctrl: 60 }, '5000004': { sigL: 6, sigA: 15 } },
    { '5000003': { sigL: 25, sigA: 50, tdA: 3, tdL: 1, ctrl: 120 }, '5000004': { sigL: 20, sigA: 40 } },
    { '5000003': { sigL: 33, sigA: 66, tdA: 4, tdL: 2, ctrl: 150 }, '5000004': { sigL: 27, sigA: 52 } },
    { '5000003': { sigL: 40, sigA: 80, tdA: 5, tdL: 2, ctrl: 200 }, '5000004': { sigL: 35, sigA: 70 } },
    { '5000003': { sigL: 40, sigA: 80, tdA: 5, tdL: 2, ctrl: 200 }, '5000004': { sigL: 35, sigA: 70 }, '5000001': { sigL: 9, sigA: 12, kd: 1 }, '5000002': { sigL: 2, sigA: 8 } }
  ];
  const times = ['2026-09-13T22:00:00Z', '2026-09-13T22:05:00Z', '2026-09-13T22:11:30Z', '2026-09-13T22:14:00Z', '2026-09-13T22:20:00Z', '2026-09-13T22:40:00Z'];
  const src = {
    async eventDetail(id) { const evs = E.parseScoreboard(docs[step]).filter(e => String(e.provider_event_id) === String(id)); return { event: evs[0], latency: 2, via: 'fixture' }; },
    async competitorStats(evId, boutId, athleteId) { const s = statsAt[step][athleteId]; if (!s) { const e = new Error('404'); e.status = 404; throw e; } const n = E.normalizeStats(M.statsDoc(s)); return { stats: n.stats, unmapped: n.unmapped, mapped: n.mapped, rounds: {}, latency: 2 }; }
  };
  async function poll(o) { return P.run(Object.assign({ event: 'espn:600099001', once: true, maxMinutes: 300, noDispatch: true, interval: 0 }, o || {}), { db: db4, source: src, now: () => times[step], sleep: async () => {} }); }
  step = 0; let r = await poll();
  chk('a pre-card poll records the next bout and no live state', r.event.event_state === 'scheduled' && r.event.current_bout_id === 'espn:401900103' && db4.count('ufc', 'fight_live_state') === 0);
  step = 1; r = await poll();
  const live2 = db4.rows('ufc', 'bouts').filter(b => b.bout_id === 'espn:401900102')[0];
  chk('the first live sighting stamps first_bell_at as the last poll that saw it pre', live2.status === 'live' && live2.first_bell_at === '2026-09-13T22:00:00Z' && live2.close_bound_source === 'observed_bell', JSON.stringify([live2.first_bell_at, live2.close_bound_source]));
  chk('the event turns live with the live bout current', r.event.event_state === 'live' && r.event.current_bout_id === 'espn:401900102' && r.event.first_bell_at === '2026-09-13T22:00:00Z');
  chk('live state is written for both corners with elapsed time', db4.rows('ufc', 'fight_live_state').filter(s => s.bout_id === 'espn:401900102').length === 2 && db4.rows('ufc', 'fight_live_state')[0].elapsed_seconds === 120);
  step = 2; r = await poll();     /* a NEW run: restart mid round 2 */
  const rr = db4.rows('ufc', 'fight_round_stats').filter(x => x.bout_id === 'espn:401900102' && x.corner === 'red').sort((a, b) => a.round - b.round);
  chk('after a restart round 1 is complete with the round-1 delta and round 2 is in progress', rr.length === 2 && rr[0].round_status === 'complete' && rr[0].sig_strikes_landed === 10 && rr[0].round_seconds === 300 && rr[1].round_status === 'in_progress' && rr[1].sig_strikes_landed === 15 && rr[1].stat_source === 'snapshot_delta', JSON.stringify(rr));
  chk('the restart kept the original bell', db4.rows('ufc', 'bouts').filter(b => b.bout_id === 'espn:401900102')[0].first_bell_at === '2026-09-13T22:00:00Z');
  const snapsBefore = db4.count('ufc', 'fight_snapshots');
  r = await poll();                /* same response again */
  chk('the same provider response twice produces no new snapshot or round row', db4.count('ufc', 'fight_snapshots') === snapsBefore && db4.rows('ufc', 'fight_round_stats').length === 4);
  step = 3; r = await poll();      /* a bout vanishes mid-card */
  const gone = db4.rows('ufc', 'bouts').filter(b => b.bout_id === 'espn:401900103')[0];
  chk('a bout that left the card mid-event is cancelled and the live bout stays current', gone.status === 'cancelled' && r.event.current_bout_id === 'espn:401900102' && r.event.event_state === 'live');
  step = 4; r = await poll();
  const fin = db4.rows('ufc', 'bouts').filter(b => b.bout_id === 'espn:401900102')[0];
  chk('the finished bout carries winner, method and elapsed time', fin.status === 'final' && fin.winner_corner === 'blue' && fin.elapsed_seconds === 900 && fin.completed_at === '2026-09-13T22:20:00Z');
  const r3 = db4.rows('ufc', 'fight_round_stats').filter(x => x.bout_id === 'espn:401900102' && x.corner === 'red').sort((a, b) => a.round - b.round);
  chk('all three rounds are complete and sum to the total', r3.length === 3 && r3.every(x => x.round_status === 'complete') && r3.reduce((n, x) => n + x.sig_strikes_landed, 0) === 40, JSON.stringify(r3.map(x => x.sig_strikes_landed)));
  chk('the next bout is current while the card is still open', r.event.current_bout_id === 'espn:401900101' && r.event.event_state === 'live' && !r.done);
  step = 5; r = await poll();
  chk('when every bout is terminal the event is final and the run says done', r.done && r.event.event_state === 'final' && r.event.bouts_completed === 2 && r.event.completed_at, JSON.stringify(r.event));
  chk('a bout seen only as final still gets its statistics once', db4.rows('ufc', 'fight_live_state').filter(s => s.bout_id === 'espn:401900101' && s.stats_available).length === 2);
  chk('the ledger recorded every run with a heartbeat and closed it', db4.rows('ufc', 'pipeline_runs').filter(x => x.job === 'ufc_live').every(x => x.finished_at && x.heartbeat_at));
  chk('the lock was released', Object.keys(db4.locks).length === 0);
  /* the lock and the hand-off */
  const db5 = seedDb();
  await syncWith(db5, M.card({ bouts: bouts() }), '2026-09-13T21:00:00Z', { market: false });
  db5.setNow(() => '2026-09-13T22:00:00Z');
  await db5.rpc('ufc', 'acquire_live_lock', { p_event_id: 'espn:600099001', p_owner: 'other-run', p_ttl_seconds: 150 });
  step = 1;
  const held = await P.run({ event: 'espn:600099001', once: true, noDispatch: true }, { db: db5, source: src, now: () => times[1], sleep: async () => {}, owner: 'me' });
  chk('a second poller stands down while the lock is held', held.status === 'cancelled' && /lock/.test(held.message) && db5.count('ufc', 'fight_live_state') === 0);
  db5.locks['espn:600099001'].expires = Date.parse('2026-09-13T21:00:00Z');
  const took = await P.run({ event: 'espn:600099001', once: true, noDispatch: true }, { db: db5, source: src, now: () => times[1], sleep: async () => {}, owner: 'me' });
  chk('an expired lock is taken over and polling proceeds', took.status === 'ok' && db5.count('ufc', 'fight_live_state') === 2);
  const db6 = seedDb();
  await syncWith(db6, M.card({ bouts: bouts() }), '2026-09-13T21:00:00Z', { market: false });
  step = 1;
  const hand = await P.run({ event: 'espn:600099001', maxMinutes: 0, noDispatch: true, interval: 0 }, { db: db6, source: src, now: () => times[1], sleep: async () => {}, owner: 'me' });
  chk('reaching the time limit mid-card hands off instead of pretending the card ended', hand.status === 'handed_off' && !hand.done && db6.rows('ufc', 'events')[0].event_state === 'live');
  /* the bell in captures: a capture stamped after the observed bell is LIVE */
  const boutsById = { 'espn:401900102': { bout_id: 'espn:401900102', status: 'live', first_bell_at: '2026-09-13T22:00:00Z', round: 2, clock: '4:00' } };
  const links = [{ bout_id: 'espn:401900102', event_id: 'espn:600099001', red_sig_key: 'k1', blue_sig_key: 'k2', draw_sig_key: null }];
  const sigNow = [Object.assign({}, SIG[0], { last_seen_at: '2026-09-13T22:03:00Z' }), Object.assign({}, SIG[1], { last_seen_at: '2026-09-13T21:59:00Z' })];
  const cr2 = S.captureRows(links, sigNow, null, boutsById, {});
  const redCap = cr2.filter(c => c.sig_key === 'k1' && c.source === 'signals')[0], blueCap = cr2.filter(c => c.sig_key === 'k2' && c.source === 'signals')[0];
  chk('a capture after the bell is tagged LIVE with round and clock; one before it is PRE', redCap.market_state === 'LIVE' && redCap.round === 2 && blueCap.market_state === 'PRE' && blueCap.round === null);
  const stateFrom = R.closingReference(cr2.filter(c => c.corner === 'red'), boutsById['espn:401900102'], null);
  chk('the LIVE capture can never become the close', !stateFrom.available || stateFrom.at !== '2026-09-13T22:03:00.000Z');

  /* ====================================================================== */
  /* 11. THE GATE                                                             */
  /* ====================================================================== */
  const evs = [{ event_id: 'a', event_state: 'scheduled', scheduled_at: '2026-09-13T22:00:00Z', name: 'A' }, { event_id: 'done', event_state: 'final', scheduled_at: '2026-09-13T22:00:00Z' }, { event_id: 'stale', event_state: 'stale', scheduled_at: '2026-09-13T22:00:00Z' }];
  chk('the gate opens 45 minutes before the start', G.pick(evs, Date.parse('2026-09-13T21:15:00Z')) && G.pick(evs, Date.parse('2026-09-13T21:15:00Z')).event_id === 'a');
  chk('and not 46', G.pick(evs, Date.parse('2026-09-13T21:14:00Z')) === null);
  chk('it stays open nine hours after the start', G.pick(evs, Date.parse('2026-09-14T07:00:00Z')).event_id === 'a' && G.pick(evs, Date.parse('2026-09-14T07:01:00Z')) === null);
  chk('a final or stale card never opens the gate', G.pick(evs.slice(1), Date.parse('2026-09-13T22:30:00Z')) === null);
  chk('a live card beats a scheduled one', G.pick([evs[0], { event_id: 'b', event_state: 'live', scheduled_at: '2026-09-13T20:00:00Z' }], Date.parse('2026-09-13T22:00:00Z')).event_id === 'b');

  const line = 'UFC pipeline | ' + pass + ' passed, ' + fail + ' failed';
  if (fail) { console.log('FAIL | ' + line); failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('PASS | ' + line);
})().catch(e => { console.error('harness error: ' + (e && e.stack || e)); process.exit(1); });
