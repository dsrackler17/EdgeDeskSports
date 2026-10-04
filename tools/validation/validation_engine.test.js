#!/usr/bin/env node
/* ============================================================================
   THE VALIDATION ENGINE — lib/edgedesk_validation.js

     node tools/validation/validation_engine.test.js

   sample states · n on every percentage · modes never blended · dimensions
   (missing is not zero) · calibration (measurement only) · CLV in points,
   price, implied probability and totals · decision expectations raise
   research alerts only on meaningful samples · the leakage audit · version
   persistence · the model autopsy never rewrites the pregame record · the
   Lab adapter · the committed ledgers read end to end
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
global.window = global.window || global;
const RC = require(path.join(ROOT, 'lib', 'research_core.js'));
const V = require(path.join(ROOT, 'lib', 'edgedesk_validation.js'));
const D = require(path.join(ROOT, 'lib', 'edgedesk_decision.js'));
require(path.join(ROOT, 'football', 'params.js'));
const E = require(path.join(ROOT, 'football', 'engine.js'));
const Q = require(path.join(ROOT, 'lib', 'edgedesk_quote_ev.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : '')); }
function section(t) { console.log('  · ' + t); }
let seed = 11; const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
function rows(n, o) {
  o = o || {};
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = o.p != null ? o.p : 0.5 + 0.1 * rand();
    const truth = o.truth != null ? o.truth : p;
    out.push(V.row(Object.assign({ id: (o.decision || 'x') + i, mode: 'LIVE', sport: 'CFB', market_type: 'spread', decision: o.decision || 'BET', units: o.units != null ? o.units : 0.5, side: rand() < 0.5 ? 'home' : 'away',
      line: 3.5, odds: -110, predicted: p, result: rand() < truth ? 'win' : 'loss', clv_points: o.clv != null ? o.clv + (rand() - 0.5) : null,
      evaluated_at: '2026-10-01T12:00:00Z', kickoff: '2026-10-01T20:00:00Z', quote_captured_at: '2026-10-01T11:55:00Z' }, o.extra || {})));
  }
  return out;
}

section('sample states are product labels with fixed boundaries');
{
  const st = (n) => V.sampleState(n).key;
  chk('49 → descriptive only', st(49) === 'DESCRIPTIVE_ONLY' && V.sampleState(49).label === 'Too early to evaluate');
  chk('50 → early signal', st(50) === 'EARLY_SIGNAL' && st(199) === 'EARLY_SIGNAL');
  chk('200 → moderate evidence ("Developing evidence")', st(200) === 'MODERATE_EVIDENCE' && V.sampleState(200).label === 'Developing evidence' && st(499) === 'MODERATE_EVIDENCE');
  chk('500 → stronger evidence ("Meaningful sample")', st(500) === 'STRONGER_EVIDENCE' && V.sampleState(500).label === 'Meaningful sample');
  /* rows of one game and market share one outcome (audit 2026-10-03) */
  const same = Array.from({ length: 30 }, (_, i) => V.row({ id: 'r' + i, mode: 'LIVE', game_id: 'G' + (i % 3), market_type: 'spread', decision: 'PASS', odds: -110, predicted: 0.55, result: i % 2 ? 'win' : 'loss' }));
  chk('rows of the same game and market count once', V.independentN(same) === 3 && V.summarize(same).independent_n === 3 && V.summarize(same).sample.n === 3, V.summarize(same).sample);
  chk('…the text says how many games are behind the rows', /\(n=30\) over 3 games/.test(V.summarize(same).text), V.summarize(same).text);
  chk('…a different market of the same game is its own outcome', V.independentN(same.concat([V.row({ mode: 'LIVE', game_id: 'G0', market_type: 'total', result: 'win' })])) === 4);
  chk('…and a row with no game id counts as its own', V.independentN([V.row({ mode: 'LIVE', result: 'win' }), V.row({ mode: 'LIVE', result: 'loss' })]) === 2);
  chk('…so repeated checkpoints never license a recalibration', V.calibration(Array.from({ length: 600 }, (_, i) => V.row({ id: 'c' + i, mode: 'LIVE', game_id: 'G' + (i % 19), market_type: 'spread', predicted: 0.55, result: i % 2 ? 'win' : 'loss' }))).recalibration === 'NOT_ALLOWED');
  chk('no recalibration below 200; at most a proposal above', V.sampleState(199).recalibration === 'NOT_ALLOWED' && V.sampleState(200).recalibration === 'PROPOSAL_ONLY' && V.sampleState(5000).recalibration === 'PROPOSAL_ONLY');
  chk('a percentage is never printed without n', V.withN(0.571, 42) === '57.1% (n=42)' && V.withN(null, 0) === '— (n=0)');
  chk('a state says it is not a verdict', /not a scientific verdict/.test(V.sampleState(10).note));
}
section('modes are never blended');
{
  const live = rows(30, { decision: 'BET' }), bt = rows(30, { decision: 'BET', extra: { mode: 'REPLAY' } });
  const mixed = V.summarize(live.concat(bt));
  chk('summarize refuses mixed modes', mixed.error === 'MIXED_MODES' && mixed.modes.length === 2, mixed);
  chk('calibration refuses mixed modes', V.calibration(live.concat(bt)).error === 'MIXED_MODES');
  chk('expectations refuse mixed modes', V.expectations(live.concat(bt)).error === 'MIXED_MODES');
  const rep = V.report(live.concat(bt));
  chk('the report keeps each mode apart', rep.modes.LIVE && rep.modes.BACKTEST && rep.modes.LIVE.all.n === 30 && rep.modes.BACKTEST.all.n === 30);
  chk('REPLAY is a backtest; GIT_RECONSTRUCTED is live-reconstructed, never LIVE', V.modeOf('REPLAY') === 'BACKTEST' && V.modeOf('GIT_RECONSTRUCTED') === 'LIVE_RECONSTRUCTED' && V.modeOf('LIVE') === 'LIVE' && V.modeOf('whatever') === null);
  const seg = V.segment(live.concat(bt), 'decision');
  chk('a segment is computed per mode', seg.modes.LIVE && seg.modes.BACKTEST && seg.modes.LIVE.buckets[0].n === 30);
  chk('the maturity ladder ends in profitability, after CLV', V.MATURITY.map((m) => m.key).join('>') === 'BACKTEST>WALK_FORWARD>LIVE_DECISIONS>LIVE_CLV>LIVE_PROFITABILITY');
}
section('dimensions: every requested cut exists; missing is not zero');
{
  ['sport', 'decision', 'unit_tier', 'market', 'confidence_band', 'calibration_source', 'reliability_band', 'price_edge_band', 'calibrated_ev_band', 'gap_band', 'favorite', 'home_away', 'division', 'key_exposure', 'market_quality', 'book_depth', 'quote_freshness', 'model_version']
    .forEach((k) => chk('dimension ' + k, !!V.DIMENSIONS[k] && typeof V.DIMENSIONS[k].of === 'function'));
  const r = V.row({ mode: 'LIVE', sport: 'CFB', decision: 'BET', units: 0.75, side: 'away', line: 3.5, odds: -110, confidence: 74, probability_source: 'partially_calibrated', reliability: 88, edge_pp: 4.9, calibrated_ev: 0.095, gap_pts: 6.3, conference_game: true, market_quality: 'VERIFIED', book_count: 5, quote_age_minutes: 12, market_type: 'spread' });
  const b = (k) => V.DIMENSIONS[k].of(r);
  chk('bands: unit 0.75U, confidence 70–79, reliability strong', b('unit_tier') === '0.75U' && b('confidence_band') === '70–79' && b('reliability_band') === 'strong');
  chk('bands: edge 4–6 pp, calibrated EV 8–12%, gap 4–7', b('price_edge_band') === '4–6 pp' && b('calibrated_ev_band') === '8–12%' && b('gap_band') === '4–7 pts', [b('price_edge_band'), b('calibrated_ev_band'), b('gap_band')]);
  chk('bands: underdog, away, conference, partially calibrated, 4–5 books, fresh', b('favorite') === 'UNDERDOG' && b('home_away') === 'AWAY' && b('division') === 'CONFERENCE' && b('calibration_source') === 'partially calibrated' && b('book_depth') === '4–5 books' && b('quote_freshness') === '<15 min');
  const noRel = rows(10, { extra: { reliability: null } });
  const seg = V.segment(noRel, 'reliability_band');
  chk('an unmeasured reliability is not a zero-reliability bucket', seg.modes.LIVE.buckets.length === 0 && seg.modes.LIVE.not_measured === 10, seg);
  chk('a stake tier exists only on a BET', V.DIMENSIONS.unit_tier.of(V.row({ decision: 'LEAN', units: 0 })) === null);
  chk('key-number exposure from a key set', V.keyExposure(3, [3, 7]) === 'ON_KEY' && V.keyExposure(-2.5, [3, 7]) === 'HOOK' && V.keyExposure(5, [3, 7]) === 'OFF_KEY' && V.keyExposure(null, [3]) === null);
  const extra = Object.assign({}, V.DIMENSIONS, { weekday: { label: 'Weekday', of: (x) => (x.evaluated_at ? new Date(x.evaluated_at).getUTCDay() : null), order: null } });
  chk('a new dimension is one key', V.segment(rows(5), extra.weekday).modes.LIVE.buckets.length === 1);
}
section('summaries: observed vs expected, CLV, ROI — each with n');
{
  const s = V.summarize(rows(120, { p: 0.56, truth: 0.56, clv: 0.5 }));
  chk('observed cover with a Wilson interval', s.decided === 120 && s.observed_cover_interval.lo < s.observed_cover && s.observed_cover_interval.hi > s.observed_cover);
  chk('expected cover is the mean prediction', Math.abs(s.expected_cover - 0.56) < 1e-9);
  chk('the text carries n and the state', /\(n=120\)/.test(s.text) && /Early signal/.test(s.text), s.text);
  chk('CLV: mean, median, beat / tie / lose, interval', s.clv.n === 120 && s.clv.beat + s.clv.tie + s.clv.lose === 120 && s.clv.interval && isFinite(s.clv.median));
  chk('ROI on staked rows; a flat 1U figure is labelled hypothetical', s.roi_n === 120 && s.flat_roi_hypothetical != null);
  const pushes = V.summarize([V.row({ mode: 'LIVE', result: 'push', odds: -110, units: 1, predicted: 0.6 }), V.row({ mode: 'LIVE', result: 'win', odds: -110, units: 1, predicted: 0.6 })]);
  chk('a push is settled, not decided, and returns the stake', pushes.settled === 2 && pushes.decided === 1 && Math.abs(pushes.units_won - 0.9091) < 1e-3, pushes);
  const cs = V.clvSummary([1, 0, 0, -0.5, 2]);
  chk('CLV summary: 2 beat, 2 tie, 1 lose, median 0', cs.beat === 2 && cs.tie === 2 && cs.lose === 1 && cs.median === 0 && cs.mean === 0.5, cs);
}
section('calibration: measurement only');
{
  const good = V.calibration(rows(2000, { p: null, extra: {} }).map((x) => x));
  chk('well-calibrated synthetic probabilities: ECE under 3 pp', good.ece < 0.03 && good.n === 2000, [good.ece, good.n]);
  const hot = V.calibration(rows(1000, { p: 0.62, truth: 0.52 }));
  chk('over-confident probabilities: the bucket error is negative (≈ −10 pp)', hot.bins.length === 1 && hot.bins[0].error_pp < -6 && hot.bins[0].inside_interval === false, hot.bins);
  const br = rows(300, { p: 0.55, truth: 0.55 });
  const c = V.calibration(br);
  const brier = br.map((x) => RC.brier(x.predicted, x.result === 'win' ? 1 : 0)).reduce((a, v) => a + v, 0) / 300;
  chk('Brier is research_core’s', Math.abs(c.brier - brier) < 1e-5, [c.brier, brier]);
  chk('log loss and a base-rate skill are reported', c.log_loss > 0 && c.brier_skill_vs_base_rate != null);
  chk('each bucket has its own n and state', c.bins.every((b) => b.n > 0 && b.sample && b.sample.key));
  chk('the note says it never moves a probability toward 50%', /never moves a probability toward 50%/.test(c.note));
  chk('small samples cannot recalibrate', V.calibration(rows(40)).recalibration === 'NOT_ALLOWED');
  chk('the example bucket: 55–57% style expected vs observed with error in pp', c.bins[0].expected === 0.55 && typeof c.bins[0].error_pp === 'number');
}
section('CLV: points, price-equivalent, implied probability, totals');
{
  chk('spread: entry +6.5, close +4.5 → +2.0', V.clv({ side: 'away', line: 6.5, odds: -110 }, { line: 4.5 }).points === 2);
  chk('spread: home −3 against a −5 close → +2.0', V.clv({ side: 'home', line: -3, odds: -110 }, { home_line: -5 }).points === 2);
  chk('spread: the close from a home line, taken on the away side (+3 taken, +1 close → +2)', V.clv({ side: 'away', line: 3, odds: -110 }, { home_line: -1 }).points === 2);
  chk('spread: a worse number than the close is negative', V.clv({ side: 'away', line: 1, odds: -110 }, { home_line: -3 }).points === -2);
  const coverAt = (center, side, line) => Q.sideProb((t) => E.dist.coverProbSpread('nfl', center, t), side, line);
  const pe = V.clv({ side: 'away', line: 3.5, odds: -110 }, { home_line: -2.5 }, { coverAt });
  chk('price-equivalent CLV: +3.5 against a +2.5 close is worth several points of cover through 3', pe.points === 1 && pe.price_pp > 5 && pe.ev_at_close > 0, pe);
  const flat = V.clv({ side: 'away', line: 3, odds: -110 }, { home_line: -3 }, { coverAt });
  chk('no line move: the number is worth exactly nothing against the close; −110 costs the vig (less the push at 3)', flat.points === 0 && flat.price_pp === 0 && flat.ev_at_close < 0 && flat.ev_at_close >= -0.0455, flat);
  const same = V.clv({ side: 'home', line: -3, odds: 100 }, { home_line: -3, odds: -125, other_odds: 105 });
  chk('same-line price CLV without a distribution: no-vig close 53.3% vs break-even 50%', same.points === 0 && Math.abs(same.price_pp - 3.252) < 0.01, same);
  const held = V.clv({ side: 'home', line: -3, odds: -105 }, { home_line: -3, odds: -115, other_odds: -105 });
  chk('… and a close carrying 4.7% hold leaves −105 slightly short (the vig is counted)', held.price_pp < 0 && held.price_pp > -0.5, held);
  const ml = V.clv({ market_type: 'moneyline', side: 'home', odds: 120 }, { odds: -105, other_odds: -115 });
  chk('moneyline: implied-probability CLV', ml.price_pp > 0 && ml.points === null, ml);
  chk('totals: over 44.5 against a 46 close is +1.5; under is −1.5', V.clv({ market_type: 'total', side: 'over', line: 44.5 }, { line: 46 }).points === 1.5 && V.clv({ market_type: 'total', side: 'under', line: 44.5 }, { line: 46 }).points === -1.5);
  chk('no close: nothing is invented', V.clv({ side: 'home', line: -3, odds: -110 }, {}).points === null);
}
section('decision expectations: research alerts, never changes');
{
  const small = rows(20, { decision: 'BET', clv: -1 }).concat(rows(20, { decision: 'LEAN', clv: 1 }));
  const e0 = V.expectations(small);
  chk('under 50 each: not evaluated, no alert', e0.alerts.length === 0 && e0.checks[0].evaluated === false && /Not evaluated/.test(e0.checks[0].text), e0.checks[0]);
  const big = rows(120, { decision: 'BET', clv: -0.5, p: 0.64, truth: 0.47 }).concat(rows(120, { decision: 'LEAN', clv: 0.8, p: 0.54, truth: 0.54, units: 0 }));
  const e1 = V.expectations(big);
  chk('BET worse than LEAN on a real sample: an alert', e1.alerts.some((a) => a.code === 'CLASS_NOT_SEPARATING' && /^WARNING: BET is not performing better than LEAN after 240 settled decisions\.$/.test(a.text)), e1.alerts);
  chk('every alert says it is not an automatic change', e1.alerts.every((a) => a.note === 'This is a research alert, not an automatic change.' && a.severity === 'RESEARCH_ALERT'));
  chk('the over-confident BET class misses its own interval', e1.alerts.some((a) => a.code === 'CALIBRATION_MISS' && /^WARNING: BET expected cover/.test(a.text)));
  const tiers = rows(40, { decision: 'BET', units: 0.5, clv: 1 }).concat(rows(43, { decision: 'BET', units: 0.75, clv: 0.2 }));
  const e2 = V.expectations(tiers);
  chk('the spec’s example: 0.75U not separating from 0.50U after 83', e2.alerts.some((a) => a.text === 'WARNING: 0.75U BET tier is not separating from 0.50U tier after 83 settled decisions.'), e2.alerts);
  const good = rows(80, { decision: 'BET', units: 0.5, clv: 0.3 }).concat(rows(80, { decision: 'BET', units: 0.75, clv: 1.2 }));
  chk('a tier that does separate raises nothing', !V.expectations(good).alerts.some((a) => a.code === 'TIER_NOT_SEPARATING'));
  chk('the rule is printed with the result', /never rewritten/.test(e2.rule));
}
section('leakage audit');
{
  const ok = rows(5);
  chk('clean pregame rows pass', V.leakageAudit(ok).ok);
  const post = V.row({ id: 'p', mode: 'LIVE', evaluated_at: '2026-10-01T21:00:00Z', kickoff: '2026-10-01T20:00:00Z' });
  const qa = V.row({ id: 'q', mode: 'LIVE', evaluated_at: '2026-10-01T12:00:00Z', kickoff: '2026-10-01T20:00:00Z', quote_captured_at: '2026-10-01T13:00:00Z' });
  const cb = V.row({ id: 'c', mode: 'LIVE', evaluated_at: '2026-10-01T12:00:00Z', kickoff: '2026-10-01T20:00:00Z', close_captured_at: '2026-10-01T11:00:00Z' });
  const wf = V.row({ id: 'w', mode: 'WALK_FORWARD', season: 2024, trained_through: 2024 });
  const nt = V.row({ id: 'n', mode: 'LIVE', kickoff: '2026-10-01T20:00:00Z' });
  const a = V.leakageAudit([post, qa, cb, wf, nt]);
  const codes = a.violations.map((x) => x.code).sort();
  chk('post-kickoff, quote-after, close-before, own-season training, no time: all caught', JSON.stringify(codes) === JSON.stringify(['CLOSE_BEFORE_EVALUATION', 'NO_EVALUATION_TIME', 'POST_KICKOFF', 'QUOTE_AFTER_EVALUATION', 'TRAINED_ON_TEST_SEASON']), codes);
}
section('version persistence: a graded decision keeps the versions that made it');
{
  const snap = { snapshot_id: 's1', game_id: 'g', sport: 'CFB', market_type: 'spread', decision: 'BET', recommended_units: 0.5, bet_price: { side: 'away', line: 6.5, odds: -105 },
    probability: 0.58, model_version: 'edgedesk_cfb_p4_v0.9.0', calibration_version: 'cfb_ev_calibration_v0', config_version: 'football_decision_config_v1', decision_engine_version: 'edgedesk_bettor_decision_v1',
    evaluated_at: '2026-09-01T12:00:00Z', kickoff: '2026-09-01T20:00:00Z' };
  const r = V.fromDecision(snap, { result: 'win', clv_points: 1 });
  chk('the row carries the snapshot’s model version, not today’s', r.model_version === 'edgedesk_cfb_p4_v0.9.0' && r.calibration_version === 'cfb_ev_calibration_v0' && r.rules_version === 'football_decision_config_v1');
  chk('… and today’s engine is a different version', D.VERSION !== snap.decision_engine_version && D.CONFIG_VERSION !== snap.config_version);
  const seg = V.segment([r, V.fromDecision(Object.assign({}, snap, { snapshot_id: 's2', model_version: 'edgedesk_cfb_p4_v1.0.0' }), { result: 'loss' })], 'model_version');
  chk('results stay grouped by the version that produced them', seg.modes.LIVE.buckets.length === 2);
}
section('the model autopsy');
{
  const snap = { game_id: 'g9', sport: 'CFB', decision: 'BET', action_reason_text: 'The current price clears EdgeDesk’s edge and expected-value thresholds.', bet_price: { label: 'Iowa +14 (-112)', line: 14, odds: -112, side: 'away' },
    distribution: { fair_home_margin: 7.7, p10: -9, p90: 24 }, probability: 0.62, model_version: 'm1', warnings: ['QB_UNCONFIRMED', 'RULES_UNVALIDATED'], frozen_at: '2026-09-20T12:00:00Z' };
  const a = V.autopsy(snap, { clv_points: -1.5, close_line: 12.5 }, { home_margin: 38 });
  chk('a 30-pt miss is a large miss', a.large_miss === true && a.result.miss_pts === 30.3, a.result);
  chk('the pregame record is quoted as frozen', a.pregame.reason === snap.action_reason_text && a.pregame.selection === 'Iowa +14 (-112)' && a.pregame.frozen_at === snap.frozen_at);
  chk('the market moved against EdgeDesk', a.market.moved_against_edgedesk === true);
  chk('the uncertainty flag that warned is named', a.uncertainty_flagged && a.warnings_at_decision.join() === 'QB_UNCONFIRMED');
  chk('outside the model’s own 80% interval', a.result.outside_model_80pct_interval === true && /outside the model’s own 80% interval/.test(a.findings[0]));
  chk('the rule: the result never rewrites the reasoning', /never used to rewrite it/.test(a.rule));
  const small = V.autopsy(snap, {}, { home_margin: 10 });
  chk('a small miss is not a large miss', small.large_miss === false);
}
section('the committed ledgers read end to end');
{
  const f = path.join(ROOT, 'football', 'cfb_lab', 'ledger', '2026', 'evaluations.jsonl');
  const raw = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const L = raw.map(V.fromLabEvaluation);
  const rep = V.report(L);
  /* LIVE is the Lab's own real-time checkpoints (origin LIVE, football/cfb_lab/
     checkpoint.js), graded once their games finish — the first landed on
     2026-10-02. They read as LIVE, never folded into the reconstructed rows,
     and are held to the same pregame rule; nothing else may read as LIVE. */
  chk('the Lab ledger splits into BACKTEST and LIVE_RECONSTRUCTED, every row labelled', rep.modes.BACKTEST && rep.modes.LIVE_RECONSTRUCTED && L.every((x) => !!x.mode), Object.keys(rep.modes));
  chk('a Lab row reads LIVE only when the Lab checkpointed it live', L.filter((x) => x.mode === 'LIVE').length === raw.filter((r) => r.origin === 'LIVE').length, Object.keys(rep.modes));
  chk('its decision time is the checkpoint’s, so the live rows are pregame', rep.modes.LIVE_RECONSTRUCTED.leakage.ok && (!rep.modes.LIVE || rep.modes.LIVE.leakage.ok),
    rep.modes.LIVE_RECONSTRUCTED.leakage.violations.concat(rep.modes.LIVE ? rep.modes.LIVE.leakage.violations : []).slice(0, 3));
  /* No sample state licenses an automatic recalibration: past 200 settled the
     most it allows is a PROPOSAL, and the state must match the sample's size. */
  chk('the Lab’s live sample never licenses an automatic recalibration, and its state matches its size', !rep.modes.LIVE || (['NOT_ALLOWED', 'PROPOSAL_ONLY'].indexOf(rep.modes.LIVE.all.sample.recalibration) >= 0
    && rep.modes.LIVE.all.sample.recalibration === V.sampleState(rep.modes.LIVE.all.sample.n).recalibration), rep.modes.LIVE && rep.modes.LIVE.all.sample);
  /* …and its size is GAMES (audit 2026-10-03): the Lab's first 600 live rows
     were 19 games (3 model versions × ~10 checkpoints each) and read
     "n=550 · Meaningful sample", a proposal license on 19 results */
  const liveGames = new Set(L.filter((x) => x.mode === 'LIVE' && (x.result === 'win' || x.result === 'loss')).map((x) => x.game_id)).size;
  chk('the Lab’s live sample state counts games, never model × checkpoint rows', !rep.modes.LIVE
    || (rep.modes.LIVE.all.independent_n === liveGames && rep.modes.LIVE.all.sample.n === liveGames && rep.modes.LIVE.all.decided >= liveGames),
    rep.modes.LIVE && { independent_n: rep.modes.LIVE.all.independent_n, games: liveGames, decided: rep.modes.LIVE.all.decided });
  chk('and its calibration license reads the same games', !rep.modes.LIVE || rep.modes.LIVE.calibration.sample.n <= liveGames,
    rep.modes.LIVE && rep.modes.LIVE.calibration.sample);
  chk('the Lab’s side-stated line is kept (AWAY 8.5 stays +8.5)', L.some((x) => x.side === 'away' && x.line === 8.5));
  chk('every Lab figure is labelled too early (n < 50 settled)', rep.modes.LIVE_RECONSTRUCTED.all.sample.key === 'DESCRIPTIVE_ONLY');
}

console.log(fail ? 'FAILURES:\n  ' + failures.join('\n  ') : '');
console.log((fail ? 'FAIL' : 'ALL GREEN') + ' validation engine — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
