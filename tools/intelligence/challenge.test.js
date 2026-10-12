#!/usr/bin/env node
/* ===========================================================================
   EDCHALLENGE — the challenge pass (lib/edgedesk_challenge.js), built on the
   real kernels: the researcher's findings and conflicts (_agents.js), EDFAIR
   evaluations, the evidence ledger and the calculation ledger.
   Checks each of the eight questions on its own failure, the outcome rules
   (critical and unsettleable → PASS; critical and settleable → RESEARCH
   REQUIRED; important → a verified candidate becomes WATCHLIST), that it
   never raises a classification, and that confidence is a category, never a
   percentage.
   Run: node tools/intelligence/challenge.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const F = require(path.join(ROOT, 'lib', 'edgedesk_fairodds.js'));
const E = require(path.join(ROOT, 'lib', 'edgedesk_evidence.js'));
const Q = require(path.join(ROOT, 'lib', 'edgedesk_quant_verify.js'));
const C = require(path.join(ROOT, 'lib', 'edgedesk_challenge.js'));
const A = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_agents.js'));
const VAL = require(path.join(ROOT, 'football', 'validation', 'pricing_nfl.json'));
let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; return; } fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 700) : '')); }
const NOW = Date.parse('2026-10-12T16:00:00Z'), KICK = Date.parse('2026-10-18T17:00:00Z');
const ago = (h) => new Date(NOW - h * 3600000).toISOString();
const HOME = 'Buffalo Bills', AWAY = 'Detroit Lions';
const norm = (raw) => A.normalize(raw, { event_ref: 'g1' });
const LIONS_IR = 'https://www.detroitlions.com/news/injury-report', BILLS_IR = 'https://www.buffalobills.com/news/injury-report';
const baseFindings = () => [
  norm({ url: BILLS_IR, retrieved_at: ago(2), published_at: ago(3), team: HOME, player: 'Khalil Shakir', role: 'WR', topic: 'availability', status: 'OUT', text: 'Khalil Shakir (ankle) ruled out' }),
  norm({ url: LIONS_IR, retrieved_at: ago(2), published_at: ago(3), team: AWAY, player: 'Brian Branch', role: 'S', topic: 'availability', status: 'OUT', text: 'Brian Branch ruled out' }),
  norm({ url: 'https://github.com/nflverse/nflverse-data/releases/download/depth_charts/depth_charts_2026.csv', kind: 'STATISTICAL_DATA', retrieved_at: ago(5), team: HOME, player: 'Josh Allen', role: 'QB', topic: 'starter', status: 'STARTING', text: 'Josh Allen is listed as the starter' })
];
const research = (fs, extra) => Object.assign({ findings: fs, conflicts: A.conflicts(fs), unresolved: A.conflicts(fs).filter((c) => c.unresolved), gaps: [], missing: [], stale: [] }, extra || {});
const evalOf = (o) => F.evaluateWager(Object.assign({ book: 'fanduel', american: -105, fair_probability: '0.535', fair_source: { kind: 'SHARP_NO_VIG', label: 'Pinnacle de-vig', observed_at: ago(0.1) }, quote_observed_at: ago(0.1), now: NOW, ttl_min: 90 }, o || {}));
const SENS_OK = (ev) => A.sensitivity({ evaluation: ev, fair_probability: Number(ev.fair_probability), price_input: { american: ev.entry_price } });
const valN = { loaded: true, tier: VAL.markets.spread.tier, basis: VAL.markets.spread.tier_basis, generated_at: VAL.generated_at, frame: VAL.frame, calibration: VAL.markets.spread.calibration, ats: VAL.markets.spread.ats_vs_close.raw_model_oos };
function run(o) {
  o = o || {};
  const fs = o.findings || baseFindings();
  const R = o.R || research(fs);
  const ev = o.ev === null ? null : (o.ev || evalOf());
  const cand = Object.assign({ home: HOME, away: AWAY, selection: HOME, side: 'home', market: 'spreads', line: -2.5, fair: { method: 'MARKET_DEVIG', label: 'Pinnacle de-vig fair' }, quote: { odds_american: -105, captured_at: ago(0.1) } }, o.candidate || {});
  const quote = o.quote || (ev ? { american: ev.entry_price, captured_at: o.quote_at || ago(0.1), source: 'edgedesk://supabase/signals/x' } : {});
  const sens = o.sens !== undefined ? o.sens : ev ? SENS_OK(ev) : null;
  const calc = Q.forCandidate(ev, { quote, fair: cand.fair, model_line: o.model_line || { market: 'spreads', side: 'home', model_line: -5.2, market_line: -2.5, sigma: 13.4 }, validation: o.validation || valN, sensitivity: sens, now: NOW, ttl_min: 90 });
  const evid = E.ledger({ findings: fs, conflicts: R.conflicts, now: NOW, kickoff: o.kickoff || KICK, sport: 'americanfootball_nfl', game_id: 'g1' });
  const cls = o.cls || { classification: 'VERIFIED_CANDIDATE', label: 'VERIFIED CANDIDATE', final_status: 'VERIFIED CANDIDATE', reasons: ['confirmed'] };
  const ch = C.challenge({ classification: cls, candidate: cand, research: R, evidence: evid, calc, disagreement: o.D || null, audit: o.audit || { checks: [] }, sensitivity: sens, adjustments: o.adjustments || [], research_level: o.level || 'GOOD', scenario_deltas: o.deltas || {}, side: cand.side });
  return { ch, calc, evid, cls };
}
const qv = (ch, id) => ch.questions.find((x) => x.id === id);

/* ---------------- the clean case ---------------- */
const c0 = run().ch;
ok('clean: all eight questions answered, in the brief\'s order, each once', c0.questions.map((x) => x.id).join() === C.QUESTIONS.map((x) => x[0]).join() && c0.questions.every((x) => x.question && x.answer), c0.questions.map((x) => [x.id, x.status]));
ok('clean: the verified candidate STANDS; nothing unresolved', c0.outcome === 'STANDS' && c0.classification.changed === false && c0.unresolved.critical === 0 && c0.unresolved.important === 0, [c0.outcome, c0.unresolved, c0.questions.filter((x) => x.status !== 'CLEAR' && x.status !== 'NOT_APPLICABLE')]);
ok('clean: a market-priced bet answers the sample and calibration questions NOT_APPLICABLE, saying why', qv(c0, 'Q3_SAMPLE_SIZE').status === 'NOT_APPLICABLE' && /de-vigged sharp market/.test(qv(c0, 'Q3_SAMPLE_SIZE').answer) && qv(c0, 'Q6_CALIBRATION').status === 'NOT_APPLICABLE' && /does not beat the base rate/.test(qv(c0, 'Q6_CALIBRATION').answer), [qv(c0, 'Q3_SAMPLE_SIZE'), qv(c0, 'Q6_CALIBRATION')]);
ok('clean: confidence is a category with reasons — never a percentage, and labelled as not a win probability', C.SCALE.includes(c0.confidence.after) && c0.confidence.after === 'HIGH' && !/%/.test(JSON.stringify(c0.confidence)) && /not a probability of winning/.test(c0.confidence.note));

/* ---------------- Q5: a stale quote → PASS ---------------- */
const evStale = evalOf({ quote_observed_at: ago(3) });
const c5 = run({ ev: evStale, quote_at: ago(3) }).ch;
ok('Q5: a 3-hour-old quote is UNRESOLVED and CRITICAL; the candidate is PASSED (rejected), research cannot fix it', qv(c5, 'Q5_STALE_QUOTE').status === 'UNRESOLVED' && qv(c5, 'Q5_STALE_QUOTE').severity === 'CRITICAL' && c5.outcome === 'PASS' && c5.classification.after === 'REJECTED' && /challenge pass/.test(c5.classification.reason), [qv(c5, 'Q5_STALE_QUOTE'), c5.classification]);
const cNo = run({ ev: null, cls: { classification: 'UNVERIFIED', reasons: ['no price'] } }).ch;
ok('Q5: no verified quote is CRITICAL; an UNVERIFIED class stays UNVERIFIED (never raised), confidence lowered', qv(cNo, 'Q5_STALE_QUOTE').severity === 'CRITICAL' && /No verified quote/.test(qv(cNo, 'Q5_STALE_QUOTE').answer) && cNo.classification.after === 'UNVERIFIED' && cNo.outcome === 'CONFIDENCE_LOWERED' && cNo.confidence.after === 'INSUFFICIENT', [cNo.classification, cNo.outcome]);

/* ---------------- Q1: contradictions ---------------- */
const qbConflict = baseFindings().concat([
  norm({ url: 'https://www.espn.com/nfl/story/_/id/allen', retrieved_at: ago(1), published_at: ago(1), team: HOME, player: 'Josh Allen', role: 'QB', key: true, topic: 'availability', status: 'OUT', text: 'Josh Allen will not play' }),
  norm({ url: 'https://apnews.com/article/allen', retrieved_at: ago(1), published_at: ago(1.5), team: HOME, player: 'Josh Allen', role: 'QB', key: true, topic: 'availability', status: 'ACTIVE', text: 'Josh Allen will play Sunday' })
]);
const c1 = run({ findings: qbConflict }).ch;
ok('Q1: an unresolved conflict about the quarterback is CRITICAL and settleable by research → RESEARCH REQUIRED', qv(c1, 'Q1_CONTRADICTIONS').status === 'UNRESOLVED' && qv(c1, 'Q1_CONTRADICTIONS').severity === 'CRITICAL' && qv(c1, 'Q1_CONTRADICTIONS').resolvable_by_research && c1.classification.after === 'RESEARCH_REQUIRED' && c1.outcome === 'DOWNGRADED' && /Josh Allen/.test(qv(c1, 'Q1_CONTRADICTIONS').answer), [qv(c1, 'Q1_CONTRADICTIONS'), c1.classification]);
ok('Q1: the contradicted evidence records are referenced', qv(c1, 'Q1_CONTRADICTIONS').refs.length === 2);
const wrConflict = baseFindings().concat([
  norm({ url: 'https://www.espn.com/nfl/story/_/id/wr', retrieved_at: ago(1), published_at: ago(1), team: AWAY, player: 'Kalif Raymond', role: 'WR', topic: 'availability', status: 'OUT', text: 'Kalif Raymond will not play' }),
  norm({ url: 'https://apnews.com/article/wr', retrieved_at: ago(1), published_at: ago(1.5), team: AWAY, player: 'Kalif Raymond', role: 'WR', topic: 'availability', status: 'ACTIVE', text: 'Kalif Raymond will play' })
]);
const c1b = run({ findings: wrConflict }).ch;
ok('Q1: an unresolved conflict about a depth player is IMPORTANT → a verified candidate becomes WATCHLIST; confidence drops a level', qv(c1b, 'Q1_CONTRADICTIONS').severity === 'IMPORTANT' && c1b.classification.after === 'WATCHLIST' && c1b.confidence.before === 'HIGH' && c1b.confidence.after === 'MODERATE', [qv(c1b, 'Q1_CONTRADICTIONS'), c1b.classification, c1b.confidence]);
const settled = baseFindings().concat([
  norm({ url: 'https://www.espn.com/nfl/story/_/id/wr2', retrieved_at: ago(1), published_at: ago(1), team: AWAY, player: 'Kalif Raymond', role: 'WR', topic: 'availability', status: 'OUT', text: 'Kalif Raymond will not play' }),
  norm({ url: LIONS_IR, retrieved_at: ago(1), published_at: ago(1), team: AWAY, player: 'Kalif Raymond', role: 'WR', topic: 'availability', status: 'ACTIVE', text: 'Kalif Raymond: no injury designation' })
]);
const c1c = run({ findings: settled }).ch;
ok('Q1: a conflict settled by source tier is CLEAR and says how it was settled', qv(c1c, 'Q1_CONTRADICTIONS').status === 'CLEAR' && /settled/.test(qv(c1c, 'Q1_CONTRADICTIONS').answer) && /tier/.test(qv(c1c, 'Q1_CONTRADICTIONS').answer), qv(c1c, 'Q1_CONTRADICTIONS'));

/* ---------------- Q2: outdated statistics ---------------- */
const oldFs = [norm({ url: BILLS_IR, retrieved_at: ago(230), published_at: ago(230), team: HOME, player: 'Khalil Shakir', role: 'WR', topic: 'availability', status: 'OUT', text: 'Khalil Shakir (ankle) ruled out' }), baseFindings()[1], baseFindings()[2]];
const c2 = run({ findings: oldFs }).ch;
ok('Q2: a 230-hour-old availability report is STALE (past 3 × 72 h) → IMPORTANT, with its age and window', qv(c2, 'Q2_OUTDATED_STATISTICS').status === 'UNRESOLVED' && qv(c2, 'Q2_OUTDATED_STATISTICS').severity === 'IMPORTANT' && /13800 min old, stale/.test(qv(c2, 'Q2_OUTDATED_STATISTICS').answer) && c2.classification.after === 'WATCHLIST', qv(c2, 'Q2_OUTDATED_STATISTICS'));
const agingFs = [norm({ url: BILLS_IR, retrieved_at: ago(100), published_at: ago(100), team: HOME, player: 'Khalil Shakir', role: 'WR', topic: 'availability', status: 'OUT', text: 'Khalil Shakir (ankle) ruled out' }), baseFindings()[1], baseFindings()[2]];
const c2a = run({ findings: agingFs }).ch;
ok('Q2: the same report 100 hours old, six days before the game, is AGING — a CONCERN that says to re-check it, not a downgrade', qv(c2a, 'Q2_OUTDATED_STATISTICS').status === 'CONCERN' && /aging, not stale/.test(qv(c2a, 'Q2_OUTDATED_STATISTICS').answer) && c2a.classification.changed === false, qv(c2a, 'Q2_OUTDATED_STATISTICS'));
const c2n = run({ findings: [norm({ url: BILLS_IR, retrieved_at: ago(30), published_at: ago(30), team: HOME, player: 'Khalil Shakir', role: 'WR', topic: 'availability', status: 'OUT', text: 'Khalil Shakir (ankle) ruled out' }), baseFindings()[1], baseFindings()[2]], kickoff: new Date(NOW + 10 * 3600000).toISOString() }).ch;
ok('Q2: a 30-hour-old availability report inside a day of the game (24 h window) is AGING and IMPORTANT', qv(c2n, 'Q2_OUTDATED_STATISTICS').status === 'UNRESOLVED' && qv(c2n, 'Q2_OUTDATED_STATISTICS').severity === 'IMPORTANT' && c2n.classification.after === 'WATCHLIST', qv(c2n, 'Q2_OUTDATED_STATISTICS'));
const wx = baseFindings().concat([norm({ url: 'https://api.open-meteo.com/v1/forecast?x', kind: 'STATISTICAL_DATA', retrieved_at: ago(20), team: HOME, topic: 'weather', text: 'Wind 9 mph at kickoff' })]);
const c2w = run({ findings: wx }).ch;
ok('Q2: an old forecast is a CONCERN (noted, not lowering), worded truthfully', qv(c2w, 'Q2_OUTDATED_STATISTICS').status === 'CONCERN' && /\(weather\)/.test(qv(c2w, 'Q2_OUTDATED_STATISTICS').answer) && c2w.classification.changed === false, qv(c2w, 'Q2_OUTDATED_STATISTICS'));
const c2b = run({ findings: [] , R: research([], { missing: [] }) }).ch;
ok('Q2: nothing dated on file is UNKNOWN (counted as unresolved), not assumed fresh', qv(c2b, 'Q2_OUTDATED_STATISTICS').status === 'UNKNOWN' && c2b.unresolved.important >= 1, qv(c2b, 'Q2_OUTDATED_STATISTICS'));

/* ---------------- Q3 and Q6: a model prices the bet ---------------- */
const evModel = (tier) => evalOf({ fair_probability: '0.56', fair_source: { kind: 'MODEL', tier, label: 'EdgeDesk model', observed_at: ago(6) } });
const mCand = (tier) => ({ fair: { method: 'MODEL_BLEND', label: 'fair line', validation: { tier } } });
const c6 = run({ ev: evModel('RESEARCH'), candidate: mCand('RESEARCH') }).ch;
ok('Q6: an unvalidated (RESEARCH-tier) model pricing the bet is CRITICAL → PASS', qv(c6, 'Q6_CALIBRATION').status === 'UNRESOLVED' && qv(c6, 'Q6_CALIBRATION').severity === 'CRITICAL' && c6.outcome === 'PASS', [qv(c6, 'Q6_CALIBRATION'), c6.outcome]);
const c6b = run({ ev: evModel('LEAN'), candidate: mCand('LEAN') }).ch;
ok('Q6: a LEAN model whose held-out Brier does not beat the base rate is IMPORTANT (not hidden behind the tier)', qv(c6b, 'Q6_CALIBRATION').status === 'UNRESOLVED' && qv(c6b, 'Q6_CALIBRATION').severity === 'IMPORTANT' && /no better than the base rate/.test(qv(c6b, 'Q6_CALIBRATION').answer) && c6b.classification.after === 'WATCHLIST', qv(c6b, 'Q6_CALIBRATION'));
const valGood = Object.assign({}, valN, { calibration: { blend_held_out: { brier: 0.231, brier_base_rate: 0.25, n: 900 } } });
const c6c = run({ ev: evModel('VALIDATED'), candidate: mCand('VALIDATED'), validation: valGood }).ch;
ok('Q6/Q3: a VALIDATED model that beats the base rate on 900 held-out games, with an adequate record at the gap, is CLEAR', qv(c6c, 'Q6_CALIBRATION').status === 'CLEAR' && qv(c6c, 'Q3_SAMPLE_SIZE').status === 'CLEAR' && /n 900/.test(qv(c6c, 'Q3_SAMPLE_SIZE').answer), [qv(c6c, 'Q6_CALIBRATION'), qv(c6c, 'Q3_SAMPLE_SIZE')]);
const valThin = Object.assign({}, valGood, { ats: { '2': { n: 140, wins: 80, pushes: 3, win_pct: 0.584, p_one_sided: 0.03 } } });
const c3 = run({ ev: evModel('VALIDATED'), candidate: mCand('VALIDATED'), validation: valThin }).ch;
ok('Q3: a record of 140 games at this gap is below the 300 the LEAN tier needs → IMPORTANT', qv(c3, 'Q3_SAMPLE_SIZE').status === 'UNRESOLVED' && /below the 300/.test(qv(c3, 'Q3_SAMPLE_SIZE').answer), qv(c3, 'Q3_SAMPLE_SIZE'));
const c3b = run({ ev: evModel('VALIDATED'), candidate: mCand('VALIDATED'), validation: { loaded: false } }).ch;
ok('Q3: a model pricing the bet with no validation sample at all is CRITICAL', qv(c3b, 'Q3_SAMPLE_SIZE').severity === 'CRITICAL' && c3b.outcome === 'PASS', qv(c3b, 'Q3_SAMPLE_SIZE'));

/* ---------------- Q4: key players ---------------- */
const gapR = research(baseFindings(), { gaps: [{ kind: 'ABSENCE_NOT_IN_MODEL', side: 'away', player: 'Penei Sewell', finding: 'f_x', detail: 'Penei Sewell (Detroit Lions, OT) is out per the official report; EdgeDesk\'s numbers do not carry it' }] });
const c4 = run({ R: gapR }).ch;
ok('Q4: a key absence the model does not carry, with no scenario pricing it → UNRESOLVED', qv(c4, 'Q4_KEY_PLAYERS').status === 'UNRESOLVED' && /Penei Sewell/.test(qv(c4, 'Q4_KEY_PLAYERS').answer) && /no model scenario/.test(qv(c4, 'Q4_KEY_PLAYERS').answer), qv(c4, 'Q4_KEY_PLAYERS'));
const c4b = run({ R: gapR, adjustments: [{ rule: 'KEY_ABSENCE', player: 'Penei Sewell' }] }).ch;
ok('Q4: the same absence priced by a model scenario is CLEAR', qv(c4b, 'Q4_KEY_PLAYERS').status === 'CLEAR' && /priced by a model scenario/.test(qv(c4b, 'Q4_KEY_PLAYERS').answer), qv(c4b, 'Q4_KEY_PLAYERS'));
const c4c = run({ R: research(baseFindings(), { missing: [{ topic: 'availability', team: AWAY }] }) }).ch;
ok('Q4: a required availability check that did not happen is UNKNOWN, naming the team', qv(c4c, 'Q4_KEY_PLAYERS').status === 'UNKNOWN' && /availability for Detroit Lions/.test(qv(c4c, 'Q4_KEY_PLAYERS').answer), qv(c4c, 'Q4_KEY_PLAYERS'));
const c4d = run({ R: research(baseFindings(), { gaps: [{ kind: 'STARTER_MISMATCH', side: 'home', player: 'Mitchell Trubisky', detail: 'Buffalo Bills: EdgeDesk\'s numbers assume Josh Allen, nflverse lists Mitchell Trubisky' }] }) }).ch;
ok('Q4: a starter mismatch is CRITICAL (settleable) → RESEARCH REQUIRED', qv(c4d, 'Q4_KEY_PLAYERS').severity === 'CRITICAL' && c4d.classification.after === 'RESEARCH_REQUIRED', qv(c4d, 'Q4_KEY_PLAYERS'));

/* one credible report of a key absence: the researcher flags it unconfirmed, never prices on it, and the challenge calls it critical */
const EVT = { id: 'g1', sport: 'americanfootball_nfl', home: HOME, away: AWAY, kickoff: KICK };
const espnOut = { url: 'https://www.espn.com/nfl/story/_/id/allen-out', retrieved_at: ago(1), published_at: ago(1), team: HOME, player: 'Josh Allen', role: 'QB', topic: 'availability', text: 'Bills quarterback Josh Allen has been ruled out for Sunday.' };
const Ru = A.research({ event: EVT, raw: [espnOut], model: { starters: { home: 'Josh Allen', away: 'Jared Goff' } }, required: [], now: NOW });
const gu = Ru.gaps.find((g) => g.kind === 'REPORTED_ABSENCE_UNCONFIRMED');
ok('researcher: one credible report that the priced quarterback is out → an UNCONFIRMED gap (not a verified absence)', gu && gu.player === 'Josh Allen' && gu.priced_starter === true && !Ru.gaps.some((g) => g.kind === 'ABSENCE_NOT_IN_MODEL') && /not confirmed by an official report/.test(gu.detail), Ru.gaps);
const Rv = A.research({ event: EVT, raw: [Object.assign({}, espnOut, { url: BILLS_IR })], model: { starters: { home: 'Josh Allen', away: 'Jared Goff' } }, required: [], now: NOW });
ok('researcher: the same report from the club\'s official page is a verified ABSENCE_NOT_IN_MODEL instead', Rv.gaps.some((g) => g.kind === 'ABSENCE_NOT_IN_MODEL') && !Rv.gaps.some((g) => g.kind === 'REPORTED_ABSENCE_UNCONFIRMED'), Rv.gaps);
const Rs = A.research({ event: EVT, raw: [Object.assign({}, espnOut, { text: 'Josh Allen could miss Sunday, per sources.' })], model: { starters: { home: 'Josh Allen', away: 'Jared Goff' } }, required: [], now: NOW });
ok('researcher: speculation ("could miss, per sources") is not even an unconfirmed gap', Rs.gaps.length === 0, Rs.gaps);
const invU = A.investigate({ candidate: { market: 'spreads', selection: HOME }, event: EVT, raw: [espnOut], model: { available: true, prices: false, tier: null, probability: null, inputs: { starters: { home: 'Josh Allen', away: 'Jared Goff' } } },
  market: { american: -105, captured_at: ago(0.1), sharp_fair: 0.535, kickoff: KICK }, market_view: { line: -2.5 }, audit: { status: 'CONFIRMED', reason: 'ok', checks: [] }, scenario_deltas: { home_qb_out: -6.5 }, sd_points: 13.4, now: NOW, ttl_min: 90, conservative: true });
ok('investigate: the unconfirmed report is never priced on (no QB-out adjustment, though a scenario delta is on file)', invU.quant.adjustments.length === 0 && invU.research.gaps.some((g) => g.kind === 'REPORTED_ABSENCE_UNCONFIRMED'), [invU.quant.adjustments, invU.research.gaps.map((g) => g.kind)]);
const clsU = A.classify({ audit: { status: 'CONFIRMED', checks: [] }, quant: { evaluation: Object.assign({}, evalOf(), { classification: 'VERIFIED_EDGE' }), adjustments: [] }, strategist: { verdict: 'SUPPORTED' }, research: { unresolved: [], gaps: Ru.gaps, findings: [] }, sensitivity: { robust: true } });
ok('classify: an otherwise verified candidate with an unconfirmed key absence is RESEARCH REQUIRED, told to confirm it', clsU.classification === 'RESEARCH_REQUIRED' && /confirm it before acting/.test(clsU.reasons[0]), clsU);
const cU = run({ R: research(baseFindings(), { gaps: Ru.gaps }) }).ch;
ok('Q4: an unconfirmed report about the priced quarterback is CRITICAL, settleable by research → RESEARCH REQUIRED', qv(cU, 'Q4_KEY_PLAYERS').status === 'UNRESOLVED' && qv(cU, 'Q4_KEY_PLAYERS').severity === 'CRITICAL' && cU.classification.after === 'RESEARCH_REQUIRED', qv(cU, 'Q4_KEY_PLAYERS'));

/* ---------------- Q7: missing data as the cause ---------------- */
const c7 = run({ candidate: { outlier: 'the projection disagrees with the market by 12 points, at or past the 7-point disagreement threshold' } }).ch;
ok('Q7: an outlier gap is a suspected data fault, CRITICAL → PASS', qv(c7, 'Q7_MISSING_DATA').severity === 'CRITICAL' && /data fault/.test(qv(c7, 'Q7_MISSING_DATA').answer) && c7.outcome === 'PASS', qv(c7, 'Q7_MISSING_DATA'));
const c7b = run({ D: { verdict: 'EXPLAINED', causes: [{ cause: 'LINEUP_ASSUMPTIONS', assessment: 'LIKELY', detail: 'the model priced the backup' }] } }).ch;
ok('Q7: a gap the diagnosis explains by a lineup assumption is IMPORTANT and "not an edge"', qv(c7b, 'Q7_MISSING_DATA').severity === 'IMPORTANT' && /not an edge/.test(qv(c7b, 'Q7_MISSING_DATA').answer), qv(c7b, 'Q7_MISSING_DATA'));
const c7c = run({ findings: [], R: research([]), audit: { checks: [{ id: 'A8_AVAILABILITY', result: 'NOT_CHECKED' }] } }).ch;
ok('Q7: availability not checked and no findings → UNKNOWN', qv(c7c, 'Q7_MISSING_DATA').status === 'UNKNOWN', qv(c7c, 'Q7_MISSING_DATA'));

/* ---------------- Q8: alternative assumptions ---------------- */
const evThin = evalOf({ fair_probability: '0.518' });
const c8 = run({ ev: evThin }).ch;
ok('Q8: an edge that does not survive a one-point error in the fair is IMPORTANT → WATCHLIST', qv(c8, 'Q8_ALTERNATIVES').status === 'UNRESOLVED' && c8.classification.after === 'WATCHLIST', [qv(c8, 'Q8_ALTERNATIVES'), c8.classification]);
const qbQ = baseFindings().concat([norm({ url: BILLS_IR, retrieved_at: ago(2), published_at: ago(2), team: HOME, player: 'Josh Allen', role: 'QB', topic: 'availability', status: 'QUESTIONABLE', text: 'Josh Allen (shoulder) questionable' })]);
const c8b = run({ findings: qbQ, deltas: { home_qb_out: -6.5, away_qb_out: 5 } }).ch;
ok('Q8: the selection\'s own quarterback questionable, with a priced loss → IMPORTANT, naming the move', qv(c8b, 'Q8_ALTERNATIVES').status === 'UNRESOLVED' && /Josh Allen \(Buffalo Bills\) is questionable/.test(qv(c8b, 'Q8_ALTERNATIVES').answer) && /-6\.5 points/.test(qv(c8b, 'Q8_ALTERNATIVES').answer), qv(c8b, 'Q8_ALTERNATIVES'));
const oppQ = baseFindings().concat([norm({ url: LIONS_IR, retrieved_at: ago(2), published_at: ago(2), team: AWAY, player: 'Jared Goff', role: 'QB', topic: 'availability', status: 'QUESTIONABLE', text: 'Jared Goff (ribs) questionable' })]);
const c8c = run({ findings: oppQ, deltas: { home_qb_out: -6.5, away_qb_out: 5 } }).ch;
ok('Q8: the OPPONENT\'s questionable quarterback is not a risk to this side (CLEAR)', qv(c8c, 'Q8_ALTERNATIVES').status === 'CLEAR', qv(c8c, 'Q8_ALTERNATIVES'));

/* ---------------- it never raises; apply() ---------------- */
const cr = run({ cls: { classification: 'REJECTED', reasons: ['net EV negative'] } }).ch;
ok('never raises: a REJECTED candidate with a clean challenge stays REJECTED', cr.classification.after === 'REJECTED' && cr.classification.changed === false);
const crr = run({ ev: evStale, quote_at: ago(3), cls: { classification: 'RESEARCH_REQUIRED', reasons: ['x'] } }).ch;
ok('a critical unsettleable item lowers RESEARCH REQUIRED to PASS too', crr.classification.after === 'REJECTED' && crr.outcome === 'PASS');
const applied = C.apply({ classification: 'VERIFIED_CANDIDATE', label: 'VERIFIED CANDIDATE', final_status: 'VERIFIED CANDIDATE', reasons: ['confirmed'] }, c1b, { label: A.CLASS_LABEL, final: A.FINAL_STATUS });
ok('apply: the class, label and final status follow the outcome; the challenge reason leads; the original class is kept', applied.classification === 'WATCHLIST' && applied.label === 'WATCHLIST' && applied.final_status === 'WATCHLIST' && /challenge pass/.test(applied.reasons[0]) && applied.reasons[1] === 'confirmed' && applied.challenged_from === 'VERIFIED_CANDIDATE', applied);
ok('apply: an unchanged outcome returns the same classification object', C.apply(run().cls, c0) === run().cls || C.apply(c0.classification, c0) === c0.classification);
const many = run({ findings: oldFs.concat(wrConflict.slice(3)), ev: evThin }).ch;
ok('several important items lower confidence one level each, to the floor', many.unresolved.important >= 3 && many.confidence.after === 'INSUFFICIENT' && many.confidence.why.length >= 3, [many.unresolved, many.confidence]);

console.log((fail ? 'FAILED ' : 'ALL GREEN ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
