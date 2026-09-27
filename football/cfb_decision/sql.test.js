#!/usr/bin/env node
/* ===========================================================================
   supabase/cfb_decision.sql against a real, throwaway PostgreSQL.

   Checks: applies clean, twice, and as one transaction; append-only for every
   role; a decision after kickoff is refused; a BET needs a captured price, a
   positive capped stake, a real edge and its versions; PASS / NO_BET need a
   reason; probabilities are probabilities; one decision per game x book x
   moment x engine x policy; one result per decision; the holdout is scored
   once; manual wagers can never be official; no PRODUCTION policy, engine or
   calibration without a person and evidence; betting cannot be enabled by an
   unvalidated policy; bankroll policies never allow more than quarter Kelly or
   an uncapped stake; the Model Lab views; authenticated reads, anon nothing;
   and the mirror's rows insert as PostgREST would.

   Run: node football/cfb_decision/sql.test.js   (CFB_DECISION_SQL_REQUIRED=1 in CI)
   =========================================================================== */
'use strict';
const path = require('path');
const PG = require('../../tools/personal/_pg.js');
const SY = require('./sync_supabase.js');

const SQL = path.join(__dirname, '..', '..', 'supabase', 'cfb_decision.sql');
let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function done(note) {
  if (note && /^SKIP/.test(note) && process.env.CFB_DECISION_SQL_REQUIRED === '1') { fail++; failures.push({ name: 'Postgres required but ' + note }); }
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
  if (note) console.log(note);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
const db = PG.start('cfbdecision');
if (!db || db.skip) done('SKIP | ' + ((db && db.skip) || 'no postgres') + ' — the SQL layer did not run');

const J = (o) => '$j$' + JSON.stringify(o) + '$j$::jsonb';
const ins = (table, row) => `insert into public.${table} select * from jsonb_populate_record(jsonb_populate_record(null::public.${table}, jsonb_build_object('recorded_at', now())), ${J(row)});`;
const hex = (c) => c.repeat(24);
const refused = (sql, re) => (re || /check constraint|violates/i).test(db.mustFail(() => db.service(sql)) || '');
const accepted = (sql) => !db.mustFail(() => db.service(sql));

try {
  const r1 = db.applyFile(SQL);
  chk('applies to a clean database, every report row ok', !/CHECK THIS/.test(r1) && (r1.match(/\|ok/g) || []).length >= 13, r1.slice(-600));
  chk('applies a second time, still ok', !/CHECK THIS/.test(db.applyFile(SQL)));
  chk('applies as ONE transaction, still ok', !/CHECK THIS/.test(db.applyFileAtomic(SQL)));

  const bet = { decision_id: 'cfbd_' + hex('1'), game_id: '401', season: 2026, week: 5, book: 'draftkings', quote_id: 'q1',
    observed_at: '2026-10-01T14:50:00.000Z', decided_at: '2026-10-01T15:00:00.000Z', kickoff_ts: '2026-10-03T19:30:00.000Z',
    engine_version: 'cfb_decision_engine_v1', engine_role: 'CHALLENGER', policy_version: 'p1', artifact_version: 'a1',
    model_version: 'edgedesk_cfb_v2.1.0', status: 'BET', timing: 'BET_NOW', side: 'HOME', line_for_side: -3.5, price: -110,
    pure_cover_probability: 0.62, decision_cover_probability: 0.56, break_even_probability: 0.5238, probability_edge: 0.036,
    theoretical_ev: 0.18, empirical_ev: 0.05, p_positive_clv: 0.58, expected_clv_pts: 0.4, stake_u: 1,
    bettable_to_line: -4.5, bettable_to_price: -118, reason_codes: ['BET_VALIDATED'], official: true, payload: {} };
  chk('a BET decision is accepted', accepted(ins('cfb_decision_snapshots', bet)));
  const v = (o, k) => ins('cfb_decision_snapshots', Object.assign({}, bet, { decision_id: 'cfbd_' + hex(k), decided_at: '2026-10-01T16:0' + k.charCodeAt(0) % 10 + ':00.000Z' }, o));
  chk('a decision at or after kickoff is refused', refused(v({ decided_at: '2026-10-03T19:30:00.000Z' }, 'a')));
  chk('a quote observed after the decision is refused', refused(v({ observed_at: '2026-10-01T18:00:00.000Z' }, 'b')));
  chk('a BET without a captured price is refused (never an assumed price)', refused(v({ price: null }, 'c')));
  chk('a BET with no stake or an uncapped stake is refused', refused(v({ stake_u: 0 }, 'd')) && refused(v({ stake_u: 5 }, 'e')));
  chk('a BET without a positive edge is refused', refused(v({ probability_edge: -0.01 }, 'f')));
  chk('a BET that names no policy or calibration is refused', refused(v({ policy_version: null }, 'g')) && refused(v({ artifact_version: null }, 'h')));
  chk('a decision without a reason is refused', refused(v({ status: 'PASS', reason_codes: [] }, 'i')));
  chk('a probability of 1 is refused', refused(v({ decision_cover_probability: 1 }, 'j')));
  chk('an impossible American price is refused', refused(v({ price: -50 }, 'k')));
  chk('an unknown status is refused', refused(v({ status: 'SMASH' }, 'l')));
  chk('a PASS with a reason and no price is accepted', accepted(v({ status: 'PASS', timing: 'NONE', price: null, stake_u: 0, reason_codes: ['PASS_PRICE'] }, 'm')));
  chk('the same game x book x moment x engine x policy twice is refused', refused(ins('cfb_decision_snapshots', Object.assign({}, bet, { decision_id: 'cfbd_' + hex('z') })), /duplicate key|unique/i));
  chk('a decision can never be marked unofficial here (manual wagers live apart)', refused(v({ official: false }, 'n')));
  for (const [op, sql] of [['update', `update public.cfb_decision_snapshots set status = 'PASS';`], ['delete', `delete from public.cfb_decision_snapshots;`],
    ['truncate', `truncate public.cfb_decision_snapshots;`]]) {
    chk('append-only: ' + op + ' is refused for the service role', /append-only|permission denied/i.test(db.mustFail(() => db.service(sql)) || ''));
    chk('append-only: ' + op + ' is refused for the owner', /append-only/i.test(db.mustFail(() => db.sql(sql)) || ''));
  }

  const res = { result_id: 'cfbr_' + hex('1'), decision_id: bet.decision_id, graded_at: '2026-10-04T03:00:00.000Z', final_margin: 7,
    ats_result: 'W', units: 0.909, closing_line_for_side: -5, closing_price: -110, clv_pts: 1.5, positive_clv: true,
    process_grade: 'GOOD_PRICE', outcome_grade: 'WIN', payload: {} };
  chk('a result with process and outcome grades is accepted', accepted(ins('cfb_decision_results', res)));
  chk('a second result for one decision is refused', refused(ins('cfb_decision_results', Object.assign({}, res, { result_id: 'cfbr_' + hex('2') })), /duplicate key|unique/i));
  chk('the Model Lab panel shows the decision beside its graded result', db.sql(`select status || '|' || ats_result || '|' || positive_clv from public.cfb_decision_lab_view where decision_id = '${bet.decision_id}'`) === 'BET|W|true');
  chk('the scorecard counts it', db.sql(`select decisions || '|' || wins from public.cfb_decision_scorecard where status = 'BET'`) === '1|1');
  chk('the shadow comparison pairs current and challenger on the same quote and moment',
    accepted(ins('cfb_decision_snapshots', Object.assign({}, bet, { decision_id: 'cfbd_' + hex('y'), engine_version: 'baseline_001', engine_role: 'CURRENT', status: 'PASS', timing: 'NONE', stake_u: 0, reason_codes: ['PASS_PRICE'] })))
    && db.sql(`select status_differs from public.cfb_decision_shadow_compare where game_id = '401'`) === 't');

  const man = { manual_id: 'cfbm_' + hex('1'), game_id: '401', book: 'fanduel', side: 'AWAY', line: 3.5, price: -110, stake_u: 2,
    decided_by: 'a person', decided_at: '2026-10-01T15:05:00.000Z', manual_decision: true, official: false, payload: {} };
  chk('a manual wager is stored apart', accepted(ins('cfb_manual_decisions', man)));
  chk('a manual wager can never be official', refused(ins('cfb_manual_decisions', Object.assign({}, man, { manual_id: 'cfbm_' + hex('2'), official: true }))));

  const pol = { policy_row_id: 'cfbp_' + hex('1'), policy_version: 'p1', status: 'UNVALIDATED_DEFAULT', bet_enabled: false,
    min_probability_edge: 0.03, min_ev: 0.03, max_price: -125, stale_minutes: 180, decided_at: '2026-09-27T00:00:00.000Z', payload: {} };
  chk('an unvalidated default policy is accepted', accepted(ins('cfb_decision_policies', pol)));
  chk('an unvalidated policy cannot enable betting', refused(ins('cfb_decision_policies', Object.assign({}, pol, { policy_row_id: 'cfbp_' + hex('2'), policy_version: 'p2', bet_enabled: true }))));
  chk('a PRODUCTION policy needs a person and evidence', refused(ins('cfb_decision_policies', Object.assign({}, pol, { policy_row_id: 'cfbp_' + hex('3'), policy_version: 'p3', status: 'PRODUCTION' }))));
  const bp = { bankroll_row_id: 'cfbb_' + hex('1'), bankroll_version: 'b1', method: 'fractional_kelly', kelly_fraction: 0.25, max_stake_u: 1,
    max_game_u: 1.5, max_slate_u: 5, status: 'RESEARCH', decided_at: '2026-09-27T00:00:00.000Z', payload: {} };
  chk('a quarter-Kelly capped bankroll policy is accepted', accepted(ins('cfb_bankroll_policy', bp)));
  chk('full Kelly is refused', refused(ins('cfb_bankroll_policy', Object.assign({}, bp, { bankroll_row_id: 'cfbb_' + hex('2'), kelly_fraction: 1 }))));
  chk('an uncapped stake is refused', refused(ins('cfb_bankroll_policy', Object.assign({}, bp, { bankroll_row_id: 'cfbb_' + hex('3'), max_stake_u: 10 }))));
  const ev = { ev_calibration_id: 'cfbe_' + hex('1'), artifact_version: 'a1', bucket_lo: 0.03, bucket_hi: 0.05, n: 400, predicted_ev: 0.04,
    realized_roi: 0.01, realized_roi_lo95: -0.05, realized_roi_hi95: 0.07, mean_clv_pts: 0.2, price_source: 'ASSUMED_-110', payload: {} };
  chk('an EV bucket names the price it assumed', accepted(ins('cfb_ev_calibration', ev)) && refused(ins('cfb_ev_calibration', Object.assign({}, ev, { ev_calibration_id: 'cfbe_' + hex('2'), price_source: 'GUESS' }))));
  const hx = { experiment_id: 'cfbx_' + hex('1'), kind: 'HOLDOUT', name: 'holdout_2024_2025', holdout_seasons: [2024, 2025], holdout_scored: true,
    started_at: '2026-09-27T00:00:00.000Z', payload: {} };
  chk('the holdout is scored once', accepted(ins('cfb_decision_experiments', hx))
    && refused(ins('cfb_decision_experiments', Object.assign({}, hx, { experiment_id: 'cfbx_' + hex('2') })), /duplicate key|unique/i));
  const mv = { version_row_id: 'cfbv_' + hex('1'), decision_version: 'cfb_decision_baseline_001', engine_version: 'edgedesk_cfb_v2 decide()',
    base_model_version: 'edgedesk_cfb_v2.1.0', status: 'BASELINE', decided_at: '2026-09-27T00:00:00.000Z', payload: {} };
  chk('the frozen baseline is registered', accepted(ins('cfb_decision_model_versions', mv)));
  chk('a PRODUCTION decision engine needs a person and evidence', refused(ins('cfb_decision_model_versions', Object.assign({}, mv, { version_row_id: 'cfbv_' + hex('2'), status: 'PRODUCTION' }))));
  const ex = { exposure_id: 'cfbx_' + hex('9'), season: 2026, week: 5, as_of: '2026-10-01T15:00:00.000Z', scope: 'GAME', scope_key: '401', positions: 2,
    stake_u: 1.5, cap_u: 1.5, scaled: true, payload: {} };
  chk('exposure within its cap is accepted, above it refused', accepted(ins('cfb_portfolio_exposure', ex))
    && refused(ins('cfb_portfolio_exposure', Object.assign({}, ex, { exposure_id: 'cfbx_' + hex('8'), stake_u: 2 }))));

  chk('authenticated reads decisions', db.as('00000000-0000-0000-0000-000000000001', `select count(*) from public.cfb_decision_snapshots;`) === '3');
  chk('anon reads nothing', /permission denied/i.test(db.mustFail(() => db.anon(`select count(*) from public.cfb_decision_snapshots;`)) || '')
    && /permission denied/i.test(db.mustFail(() => db.anon(`select count(*) from public.cfb_decision_lab_view;`)) || ''));

  const now = new Date();
  const season = now.getUTCMonth() <= 1 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const P = SY.plan(season);
  const bad = [];
  for (const x of P.filter((y) => y.rows.length)) {
    const e = db.mustFail(() => db.service(x.rows.slice(0, 40).map((r) => ins(x.table, r)).join('\n')));
    if (e && !/duplicate key/.test(e)) bad.push({ table: x.table, error: e.slice(0, 200) });
  }
  chk('the mirror\'s rows insert as PostgREST would insert them', !bad.length, bad);
} finally {
  db.stop();
}
done();
