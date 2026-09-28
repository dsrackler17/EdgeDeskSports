#!/usr/bin/env node
/* ============================================================================
   Tests for the live-validation layer (football/cfb_validation).

   What must never break:
     1  version boundaries: CURRENT is only LIVE snapshots of the frozen
        champion at or after the freeze; LEGACY is never blended into it;
     2  model, market and betting stay three separate sections, and a research
        lean is never counted as a qualified wager;
     3  the divergence monitor removes the two scales' offset, flags only the
        top of the distribution, and never feeds a price;
     4  gate verdicts are read as frozen on the snapshot: a 7+ gap without one is
        NOT RUN, never re-judged in hindsight;
     5  postmortems classify by evidence, and a lucky win is not a good process;
     6  a research trigger needs its threshold AND its minimum sample, and a
        fired trigger opens a candidate that is never auto-implemented;
     7  a fair-line move is never attributed to the market;
     8  a change to the pricing code becomes a declared PATCH, and no historical
        row is altered;
     9  the committed artifacts obey all of the above on the real ledger.

   Run: node football/cfb_validation/tests.js
   ============================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const HERE = __dirname;
const ROOT = path.join(HERE, '..', '..');
const V = require(path.join(HERE, 'core.js'));
const F = require(path.join(HERE, 'freeze.js'));
const Canon = require(path.join(ROOT, 'lib', 'edgedesk_canon.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 300); } }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
}
function eq(name, got, want) { chk(name, got === want, 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

/* ------------------------------------------------------------ fixtures */
const FREEZE = { release_id: 'r_test', effective_at: '2026-09-28T00:00:00.000Z', champion: { model_version: 'V1' } };
let seq = 0;
function ev(o) {
  seq++;
  return Object.assign({ prediction_id: 'p' + seq, game_id: 'g' + seq, model_version: 'V1', origin: 'LIVE', checkpoint_type: 'T24', result_status: 'FINAL', void: false,
    season: 2026, week: 5, kickoff_ts: '2026-10-03T19:00:00.000Z', prediction_ts: '2026-10-02T19:00:00.000Z', final_margin: 7, abs_margin_error: 5,
    squared_margin_error: 25, margin_error: 5, p_home: 0.6, home_won: 1, brier_win: 0.16, decision_class: 'PASS' }, o || {});
}

/* 1. epochs and views */
eq('LIVE after the freeze is CURRENT', V.epochOf(ev(), FREEZE, []), 'CURRENT');
eq('LIVE before the freeze is PRE_FREEZE', V.epochOf(ev({ prediction_ts: '2026-09-27T15:07:15.000Z' }), FREEZE, []), 'PRE_FREEZE');
eq('a reconstructed row is LEGACY', V.epochOf(ev({ origin: 'GIT_RECONSTRUCTED' }), FREEZE, []), 'LEGACY');
eq('a replay row is LEGACY', V.epochOf(ev({ origin: 'REPLAY' }), FREEZE, []), 'LEGACY');
eq('another model is not the champion', V.epochOf(ev({ model_version: 'V2' }), FREEZE, []), 'OTHER_MODEL');
const D1 = { preds: [], results: [], evals: [
  ev({ abs_margin_error: 4 }), ev({ abs_margin_error: 6 }),
  ev({ origin: 'GIT_RECONSTRUCTED', abs_margin_error: 30, checkpoint_type: 'OPEN' }),
  ev({ prediction_ts: '2026-09-27T15:07:15.000Z', abs_margin_error: 40 }),
  ev({ checkpoint_type: 'OPEN', abs_margin_error: 50 })
] };
const VW = V.views(D1, FREEZE, [], { bet_enabled: false }, 2026);
const since = VW.find((v) => v.id === 'SINCE_UPGRADE');
eq('since-upgrade counts only official LIVE rows after the freeze', since.football_model.n, 2);
eq('since-upgrade MAE is theirs alone', since.football_model.mae, 5);
eq('legacy is kept, separately', VW.find((v) => v.id === 'LEGACY').football_model.n, 1);
chk('every view carries the three separate sections', VW.every((v) => v.football_model && v.market_intelligence && v.betting_decisions));
chk('views exist for all historical, champion, season, last N, since upgrade and legacy',
  ['ALL_HISTORICAL', 'CURRENT_CHAMPION', 'CURRENT_SEASON', 'LAST_25', 'LAST_50', 'LAST_100', 'SINCE_UPGRADE', 'LEGACY'].every((id) => VW.some((v) => v.id === id)));

/* 2. betting is separate */
const bd = V.bettingDecisions([ev({ decision_class: 'LEAN', ats_result: 'WIN', side: 'home', graded_line: -3, units: 0.91 })], { bet_enabled: false });
eq('a research lean is not a qualified wager', bd.qualified_wagers.decisions || 0, 0);
chk('research leans are labelled hypothetical', /HYPOTHETICAL/.test(bd.research_positions_hypothetical.label));
eq('betting disabled is stated', bd.betting_enabled, false);

/* 3. divergence monitor */
const teams = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({ key: 't' + i, team: 'T' + i, current: i, state: i - 3 + (i === 9 ? 6 : 0),
  etsr: { rating: i }, state_detail: { value: i - 3 + (i === 9 ? 6 : 0), carried: i, this_season: i - 5, prior_weight: 0.8, games_played: 4 } }));
const M = V.divergenceMonitor(teams, Canon, {});
eq('the scale offset is removed (a uniform −3 shift is no divergence)', M.teams.find((t) => t.key === 't0').rating_state_divergence, 0.6);
eq('the one genuinely different team is the largest', M.largest[0].key, 't9');
chk('only the top of the distribution is flagged', M.flagged.length >= 1 && M.flagged.length <= 2);
chk('every team says why, from the model structure', M.teams.every((t) => t.why.length >= 1 && /long-run trained state/.test(t.why[0])));
chk('the monitor declares itself diagnostic only', /Nothing reads this back into a price/.test(M.diagnostic_only));

/* 4. signals: frozen verdicts only */
const P = (o) => Object.assign({ origin: 'LIVE', engine_id: 'edgedesk_cfb_p4', game_id: 'sg', week: 5, home_team: 'H', away_team: 'A', sportsbook_count: 3 }, o);
const D2 = { evals: [{ game_id: 'sg', close_home_line: -8 }, { game_id: 'nr', close_home_line: -2 }], results: [{ game_id: 'sg', status: 'FINAL', final_margin: 10 }],
  preds: [P({ prediction_id: 'a', prediction_ts: '2026-10-01T00:00:00Z', pure_home_margin: 12, current_spread: -3, model_market_gap: 9, disagreement_status: 'VERIFIED_MAJOR_DISAGREEMENT' }),
    P({ prediction_id: 'b', game_id: 'nr', prediction_ts: '2026-10-01T00:00:00Z', pure_home_margin: 12, current_spread: -3, model_market_gap: 9 })] };
const S2 = V.signals(D2, null);
eq('a verified snapshot is scored', S2.verified.summary.n, 1);
eq('the close moving 5 pts toward EdgeDesk counts as movement toward', S2.verified.games[0].moved_toward, true);
eq('EdgeDesk closer than the snapshot market', S2.verified.games[0].edgedesk_closer_than_snapshot_market, true);
eq('a 7+ gap with no verdict on file is NOT RUN, not re-judged', S2.verdict_not_run.n, 1);
chk('the comparison waits for 30 settled of each', S2.comparison.ready === false && /Building/.test(S2.comparison.reading));
const list = [P({ prediction_ts: '2026-10-01T00:00:00Z', pure_home_margin: 12, current_spread: -3, model_market_gap: 9, disagreement_status: 'INVESTIGATE', disagreement_root_cause: 'THIN_MARKET' }),
  P({ prediction_ts: '2026-10-02T00:00:00Z', pure_home_margin: 12, current_spread: -5, model_market_gap: 7, disagreement_status: 'INVESTIGATE' })];
eq('a market that came 2 pts to EdgeDesk explains an INVESTIGATE', V.investigateOutcome(list, list[0], null), 'MARKET_MOVED');
const list2 = [list[0], P({ prediction_ts: '2026-10-02T00:00:00Z', pure_home_margin: 8, current_spread: -3, model_market_gap: 5 })];
eq('EdgeDesk moving to the market is a natural shrink', V.investigateOutcome(list2, list2[0], null), 'SHRANK_NATURALLY');
eq('a later pass is LATER_VERIFIED', V.investigateOutcome([list[0], P({ prediction_ts: '2026-10-02T00:00:00Z', pure_home_margin: 12, current_spread: -3, model_market_gap: 9, disagreement_status: 'VERIFIED_MAJOR_DISAGREEMENT' })], list[0], null), 'LATER_VERIFIED');

/* 5. postmortems */
const yes = { answer: 'YES' }, no = { answer: 'NO' }, unk = { answer: 'UNKNOWN' };
const base = { data_failure: unk, beat_closing_line: unk, market_moved_toward_edgedesk: unk };
eq('a data failure is BAD DATA first', V.classifyLoss({}, Object.assign({}, base, { data_failure: yes, beat_closing_line: yes })), 'BAD_DATA');
eq('beating the close and losing is GOOD PROCESS / BAD OUTCOME', V.classifyLoss({}, Object.assign({}, base, { beat_closing_line: yes })), 'GOOD_PROCESS_BAD_OUTCOME');
eq('losing the close and a market that went away is BAD PRICE', V.classifyLoss({ abs_margin_error: 10, close_abs_error: 8 }, Object.assign({}, base, { beat_closing_line: no, market_moved_toward_edgedesk: no })), 'BAD_PRICE');
eq('a close that missed by 7+ less is BAD MODEL', V.classifyLoss({ abs_margin_error: 25, close_abs_error: 10 }, Object.assign({}, base, { beat_closing_line: no, market_moved_toward_edgedesk: no })), 'BAD_MODEL');
eq('a close that missed as badly is NORMAL VARIANCE', V.classifyLoss({ abs_margin_error: 20, close_abs_error: 19 }, base), 'NORMAL_VARIANCE');
eq('a win that lost the close is BAD PROCESS / GOOD OUTCOME', V.classifyWin({}, Object.assign({}, base, { beat_closing_line: no })), 'BAD_PROCESS_GOOD_OUTCOME');
eq('a win whose projection missed by 14+ is not a good process', V.classifyWin({ abs_margin_error: 18 }, Object.assign({}, base, { beat_closing_line: yes })), 'BAD_PROCESS_GOOD_OUTCOME');
eq('a win that beat the close is GOOD PROCESS / GOOD OUTCOME', V.classifyWin({ abs_margin_error: 4 }, Object.assign({}, base, { beat_closing_line: yes })), 'GOOD_PROCESS_GOOD_OUTCOME');
chk('an unknown check stays UNKNOWN with its reason', (function () { const c = V.checklist({}, null, null); return c.turnover_outlier.answer === 'UNKNOWN' && /never assumed/.test(c.turnover_outlier.source); })());

/* 6. triggers and backlog */
const T0 = V.triggers({ evals: [], preds: [] }, FREEZE, [], {});
eq('nothing fires on nothing', T0.state, 'NO STRUCTURAL MODEL ISSUE DETECTED');
chk('an empty sample is INSUFFICIENT, not QUIET', T0.triggers.every((t) => t.status === 'INSUFFICIENT_SAMPLE'));
const favPreds = [], favEvals = [];
for (let i = 0; i < 120; i++) {
  const id = 'fp' + i;
  favPreds.push({ prediction_id: id, pure_home_margin: 10 + (i % 5), inputs_ref: {} });
  favEvals.push(ev({ prediction_id: id, game_id: 'fg' + i, final_margin: 4 + (i % 3), abs_margin_error: 6 }));
}
const T1 = V.triggers({ evals: favEvals, preds: favPreds }, FREEZE, [], {});
eq('a persistent favourite over-projection over 100+ games fires', T1.triggers.find((t) => t.id === 'FAVORITE_BIAS').status, 'FIRED');
chk('one ugly game never fires a trigger', V.triggers({ evals: [ev({ abs_margin_error: 45 })], preds: [] }, FREEZE, [], { reference_mae: 12.6 }).live_fired.length === 0);
const bl = V.backlogEvents([], T1, '2026-10-05T00:00:00Z', null);
chk('a fired trigger opens a candidate', bl.length >= 1 && bl[0].event === 'OPENED');
chk('a candidate is never auto-implemented and goes to CHALLENGER next', bl.every((x) => x.auto_implemented === false && x.next_stage === 'CHALLENGER' && x.stage === 'RESEARCH'));
eq('an open candidate is not opened twice', V.backlogEvents(bl, T1, '2026-10-06T00:00:00Z', null).length, 0);

/* 7. attribution */
const s0 = { at: 't0', home_margin: 5, model_version: 'V1', qb: { home: { player: 'A', status: 'EXPECTED' } }, components: { rating: 2, hfa: 4, matchup: -1 }, games_played: { home: 4, away: 4 }, market_home_line: -3 };
eq('a market-only move leaves nothing to attribute', V.attributeChange(s0, Object.assign({}, s0, { at: 't1', market_home_line: -7 })).causes.length, 0);
chk('an unexplained fair move is UNATTRIBUTED, never the market', (function () {
  const c = V.attributeChange(s0, Object.assign({}, s0, { at: 't1', home_margin: 6.5 })).causes;
  return c.length === 1 && c[0].cause === 'UNATTRIBUTED' && !c.some((x) => /MARKET/.test(x.cause));
})());
chk('a new game absorbed is named', V.attributeChange(s0, Object.assign({}, s0, { home_margin: 7, games_played: { home: 5, away: 4 }, components: { rating: 4, hfa: 4, matchup: -1 } })).causes.some((c) => c.cause === 'NEW_GAME_ABSORBED'));
chk('a quarterback change is named', V.attributeChange(s0, Object.assign({}, s0, { home_margin: 1, qb: { home: { player: 'B', status: 'ANNOUNCED' } }, components: { rating: 2, hfa: 4, matchup: -1, injury: -3.9 } })).causes.some((c) => c.cause === 'QB_STATUS'));
chk('a pricing-code change is a software patch', V.attributeChange(Object.assign({}, s0, { pricing_fingerprint: 'a' }), Object.assign({}, s0, { home_margin: 5.3, pricing_fingerprint: 'b' })).causes.some((c) => c.cause === 'SOFTWARE_PATCH'));
chk('a snapshot without components is never split by term (no full term value read as a change)', (function () {
  const old = Object.assign({}, s0); delete old.components;
  const c = V.attributeChange(old, Object.assign({}, s0, { at: 't1', home_margin: 3.4, components: { rating: -12.41, hfa: 4.08, matchup: -2.26 } })).causes;
  return c.length === 1 && c[0].cause === 'TERMS_NOT_RECORDED' && !c.some((x) => x.term);
})());
chk('a term split reconciles with the move it explains', (function () {
  const ch = V.attributeChange(s0, Object.assign({}, s0, { at: 't1', home_margin: 6.2, components: { rating: 3.2, hfa: 4, matchup: -1 } }));
  return ch.causes.length === 1 && ch.causes[0].points === 1.2 && Math.abs(ch.unexplained) < 0.01;
})());
eq('a move under the threshold is not material', V.attributeChange(s0, Object.assign({}, s0, { home_margin: 5.2 }), 0.5).material, false);

/* 8. versions */
const fp = F.fingerprint('PRICING');
const fake = [{ event: 'RELEASE', kind: 'PRICING', version: 'r', base_version: 'r', effective_at: '2026-09-28T00:00:00Z', fingerprint: 'stale', files: Object.assign({}, fp.files, { 'football/cfb_p4/engine.js': 'old' }) }];
const d = F.drift(fake, '2026-10-01T00:00:00Z');
chk('a changed pricing file appends a PATCH', d.length === 1 && d[0].event === 'PATCH' && d[0].kind === 'PRICING');
chk('the patch names the changed file', d[0] && d[0].changed_files.indexOf('football/cfb_p4/engine.js') >= 0);
chk('a patch never alters history', d[0] && d[0].historical_rows_altered === false);
eq('the version in force is read by timestamp', V.versionAt(fake.concat(d), '2026-10-02T00:00:00Z', 'PRICING').event, 'PATCH');
eq('before the patch the release is in force', V.versionAt(fake.concat(d), '2026-09-29T00:00:00Z', 'PRICING').event, 'RELEASE');

/* 9. next 100 */
const n = V.next100({ plan_id: 'x', metrics: [{ id: 'margin_mae', better_if: 'lower' }], baselines: { margin_mae: { value: 12.9 } } }, VW);
chk('no comparison is printed before 100 games', n.ready === false && n.comparison === null && /Building/.test(n.note));

/* ------------------------------------------------ the committed artifacts */
const S = F.load();
chk('the champion freeze exists', !!S.champion && !!S.champion.effective_at && !!S.champion.fingerprints.PRICING);
chk('the version log starts with the release', S.versions.length >= 3 && S.versions.slice(0, 3).every((v) => v.event === 'RELEASE'));
chk('the next-100 plan is frozen with baselines', !!S.plan && S.plan.metrics.length >= 7 && S.plan.baselines.margin_mae && S.plan.baselines.margin_mae.value != null);
chk('the pricing fingerprint matches the freeze or a declared patch', (function () {
  const cur = F.fingerprint('PRICING').sha, rows = S.versions.filter((v) => v.kind === 'PRICING');
  return rows[rows.length - 1].fingerprint === cur;
})(), 'the pricing code changed without a PATCH row: run node football/cfb_validation/build.js (it appends one)');
const live = read('football/cfb_validation/live.json');
chk('the dashboard asks the one question', /getting better/.test(live.question));
chk('the north star names the frozen version', live.north_star.current_model_version === S.champion.champion.model_version && live.north_star.release === S.champion.release_id);
chk('the dashboard keeps model, market and betting apart', /apart/.test(live.separation));
chk('every view is a named, separated view', live.views.every((v) => v.football_model && v.market_intelligence && v.betting_decisions && v.note));
const div = read('football/cfb_validation/divergence.json');
eq('the divergence monitor covers every active FBS program', div.n + div.missing.length, read('football/rating/current.json').teams.length);
chk('the monitor reports median, p90 and the largest', div.median_abs != null && div.p90_abs != null && div.largest.length > 0);
chk('both names are the canonical ones', div.names.current.label === 'CURRENT FBS POWER RATING' && div.names.state.label === 'PRODUCTION PRICING STATE');
const mat = read('football/cfb_validation/maturity.json');
chk('every module has a maturity, a pricing impact and a reason', mat.modules.every((m) => Canon.MATURITY[m.status] && (m.pricing_impact === 'YES' || m.pricing_impact === 'NO') && m.reason));
chk('no module is PRODUCTION VALIDATED without the evidence', mat.modules.every((m) => m.status !== 'PRODUCTION_VALIDATED'));
const audit = read('football/cfb_validation/slate_audit.json');
chk('no VERIFIED status stands on a failed requirement', audit.games.every((g) => g.research_status !== 'VERIFIED_MAJOR' || g.requirements.every((q) => q.result === 'PASS')));
eq('the audit finds no status that contradicts its checks', audit.inconsistent.length, 0);
const bt = read('football/cfb_validation/divergence_backtest.json');
chk('the backtest bands are fitted on the development fold only', /DEV 2015–2021 only/.test(bt.bands.fitted_on));
chk('the backtest never changes production', /fair spread is unchanged/.test(bt.production_effect));
chk('the verdict follows its declared rule', (function () {
  const H = bt.folds.HOLDOUT_2022_2025, Dv = bt.folds.DEV_2015_2021, ci = bt.mae_difference_large_minus_low_ci95.HOLDOUT_2022_2025;
  if (bt.verdict.status === 'PREDICTS_ERROR') return ci[0] > 0 && Dv.LARGE.mae > Dv.LOW.mae;
  if (bt.verdict.status === 'DIRECTIONAL') return !(ci[0] > 0) && Dv.LARGE.mae > Dv.LOW.mae && H.LARGE.mae > H.LOW.mae;
  return true;
})());
const backlog = F.readJsonl(path.join(HERE, 'backlog.jsonl'));
chk('every backlog candidate is research, not an implementation', backlog.every((x) => x.auto_implemented === false && x.stage === 'RESEARCH'));
const weekly = fs.existsSync(path.join(HERE, 'weekly')) ? fs.readdirSync(path.join(HERE, 'weekly')).filter((f) => /\.json$/.test(f)) : [];
chk('weekly scorecards carry this week, rolling 4, season and the current version', weekly.every((f) => { const w = read('football/cfb_validation/weekly/' + f); return w.this_week && w.rolling_4_weeks && w.season_to_date && w.current_model_version && w.report && /Research trigger/.test(w.report.text); }));
chk('a legacy week says so in its report', weekly.every((f) => { const w = read('football/cfb_validation/weekly/' + f); return w.epoch !== 'LEGACY' || /LEGACY/.test(w.report.text); }));

/* the terminal carries the canonical split on every row */
const board = read('football/cfb_terminal/board.json');
chk('every board row carries a research status and a separate decision status', board.rows.every((x) => Canon.RESEARCH_STATUS[x.research_status] && Canon.DECISION_STATUS[x.decision_status]));
chk('no board row shows BET or WAIT while the policy forbids it', board.rows.every((x) => ['BET', 'WAIT'].indexOf(x.decision_status) < 0 || board.decision.bet_enabled));
chk('the board counters reconcile to the slate', board.counts.hierarchy && board.counts.hierarchy.reconciles === true && board.counts.hierarchy.all === board.rows.length);
chk('a VERIFIED research status never comes with a BET decision while betting is disabled', board.rows.every((x) => x.research_status !== 'VERIFIED_MAJOR' || x.decision_status !== 'BET'));

if (fail) { console.log(failures.map((f) => 'FAIL | ' + f).join('\n')); console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(1); }
console.log('ALL GREEN ' + pass + ' passed, 0 failed');
