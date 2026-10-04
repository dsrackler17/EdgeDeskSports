#!/usr/bin/env node
/* ===========================================================================
   supabase/cfb_market_integrity.sql against a real, throwaway PostgreSQL
   (tools/personal/_pg.js), on top of supabase/cfb_lab.sql.

   Checks: applies clean, twice, and as one transaction, with every report row
   ok; the hard quote rules reproduce every shared case in
   fixtures/integrity_rules.json (the same cases integrity.js and the capture
   function pass); a missing field is never 0; the quarantine keeps a +450
   spread and American odds of 0 with their reasons, once per quote, and is
   append-only; the CHECKED ingest forwards clean quotes to
   cfb_lab_ingest_quotes and never a bad one; settlement refuses a tied, a
   negative, an impossible or a scoreless FINAL and accepts a postponement;
   a wager is graded once; a frozen prediction's entry line, price and
   decision cannot be changed after the fact; line corrections are audited
   and append-only; the guarded role change refuses an unconfirmed version,
   an unregistered model, a missing reason and a direct retirement of the
   champion; the BET-volume view reads; anon executes and reads nothing.

   Run: node football/cfb_lab/integrity_sql.test.js   (CFB_LAB_SQL_REQUIRED=1 in CI)
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require('../../tools/personal/_pg.js');
const CP = require('./checkpoint.js');
const SY = require('./sync_supabase.js');
const L = require('./lab_core.js');

const ROOT = path.join(__dirname, '..', '..');
const LAB_SQL = path.join(ROOT, 'supabase', 'cfb_lab.sql');
const SQL = path.join(ROOT, 'supabase', 'cfb_market_integrity.sql');
const TEXT = fs.readFileSync(SQL, 'utf8');
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'integrity_rules.json'), 'utf8'));

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function done(note, db) {
  if (note && /^SKIP/.test(note) && process.env.CFB_LAB_SQL_REQUIRED === '1') { fail++; failures.push({ name: 'Postgres required but ' + note }); }
  if (db && db.stop) db.stop();
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
  if (note) console.log(note);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* ═══ STATIC ═══════════════════════════════════════════════════════════ */
chk('no psql meta-command (the SQL editor cannot run one)', !TEXT.split('\n').some((l) => l.trimStart().startsWith('\\')));
chk('ends in a report select that names CHECK THIS', /\n(select|with)[\s\S]*;\s*$/i.test(TEXT) && /CHECK THIS/.test(TEXT));
chk('drops nothing but triggers (additive, never destructive)', !/\bdrop\s+(table|view|schema|function|index|column|policy\s+(?!if exists %I))/i.test(TEXT.replace(/drop policy if exists %I/g, '')) && !/\btruncate\b\s+(table\s+)?public\./i.test(TEXT)
  && !/alter table public\.cfb_lab_/i.test(TEXT));
chk('tables are created idempotently; functions and views are create-or-replace',
  /create table if not exists public\.cfb_market_quote_quarantine/.test(TEXT) && /create table if not exists public\.cfb_market_line_corrections/.test(TEXT)
  && !/create function/i.test(TEXT.replace(/create or replace function/gi, '')) && !/create view/i.test(TEXT.replace(/create or replace view/gi, '')));
chk('writer functions are security definer with a pinned search_path',
  ['cfb_market_quarantine_quotes', 'cfb_market_ingest_quotes', 'cfb_market_admin_set_role'].every((f) =>
    new RegExp('function public\\.' + f + '\\([^)]*\\)[\\s\\S]{0,120}security definer\\s+set search_path = pg_catalog, pg_temp').test(TEXT)));
chk('the fixture has cases of every rule', ['SPREAD_OUT_OF_BOUNDS', 'TOTAL_OUT_OF_BOUNDS', 'PRICE_ZERO', 'PRICE_NOT_AMERICAN', 'PRICE_OUT_OF_BOUNDS', 'PRICE_NOT_INTEGER',
  'IDENTICAL_SIDE_PRICES', 'TWO_WAY_HOLD_TOO_HIGH', 'TWO_WAY_BELOW_FAIR', 'OBSERVED_IN_FUTURE', 'PROVIDER_TS_AFTER_OBSERVED', 'PROVIDER_TS_UNPARSEABLE', 'NON_NUMERIC_HOME_LINE']
  .every((c) => FIX.quote_cases.some((x) => x.expected.includes(c))) && FIX.quote_cases.some((x) => !x.expected.length));

/* ═══ LIVE ═══════════════════════════════════════════════════════════════ */
const db = PG.start('cfbinteg');
if (!db || db.skip) done('SKIP | ' + ((db && db.skip) || 'no postgres') + ' — the SQL layer did not run');
const J = (o) => '$j$' + JSON.stringify(o) + '$j$::jsonb';
const refused = (sql, re) => (re || /check constraint|violates|append-only|refused|must|required|cannot|not registered|at least|tied|needs/i).test(db.mustFail(() => db.service(sql)) || '');
const accepted = (sql) => { const e = db.mustFail(() => db.service(sql)); if (e) failures.push({ name: '(accepted expected)', detail: e.slice(0, 300) }); return !e; };
const one = (sql) => db.sql(sql).trim();
const ins = (table, row) => `insert into public.${table} select * from jsonb_populate_record(jsonb_populate_record(null::public.${table}, jsonb_build_object('recorded_at', now())), ${J(row)});`;

try {
  const lab = db.applyFile(LAB_SQL);
  chk('cfb_lab.sql applies first', !/CHECK THIS/.test(lab), lab.slice(-300));
  const r1 = db.applyFile(SQL);
  chk('applies to a clean cfb_lab database, every report row ok', !/CHECK THIS/.test(r1) && (r1.match(/\|ok/g) || []).length === 8, r1);
  chk('applies a second time, still ok', !/CHECK THIS/.test(db.applyFile(SQL)));
  chk('applies as ONE transaction, still ok', !/CHECK THIS/.test(db.applyFileAtomic(SQL)));

  /* ---- the hard quote rules: the shared cases ------------------------ */
  let parity = 0; const mism = [];
  FIX.quote_cases.forEach((c) => {
    const got = JSON.parse(one(`select coalesce(array_to_json(public.cfb_market_quote_problems(${J(c.quote)}, '${FIX.now}'::timestamptz)), '[]'::json)`));
    if (JSON.stringify(got.slice().sort()) === JSON.stringify(c.expected.slice().sort())) parity++; else mism.push({ why: c.why, got, expected: c.expected });
  });
  chk('Postgres reproduces every shared quote case (' + FIX.quote_cases.length + ')', parity === FIX.quote_cases.length, mism.slice(0, 3));
  chk('a missing field is never 0: JSON null, "" and text are not numbers; "-3.5" is',
    one(`select public.cfb_market_strict_num('null'::jsonb) is null and public.cfb_market_strict_num('""'::jsonb) is null and public.cfb_market_strict_num('"abc"'::jsonb) is null and public.cfb_market_strict_num('"-3.5"'::jsonb) = -3.5`) === 't');

  /* ---- quarantine ---------------------------------------------------- */
  const now = '2026-10-01T12:00:00.000Z';
  const base = { source: 'odds_api', provider_event_id: 'ev1', book: 'dk', observed_at: '2026-10-01T11:50:00.000Z', kickoff_ts: '2026-10-03T19:30:00.000Z',
    home_team: 'Texas Longhorns', away_team: 'Oklahoma Sooners', is_pregame: true, is_provider_open: false, is_provider_close: false };
  const q450 = Object.assign({}, base, { market_type: 'spread', home_line: 450, price_home: -110, price_away: -110 });
  const q0 = Object.assign({}, base, { market_type: 'moneyline', price_home: 0, price_away: -150 });
  const qr = JSON.parse(one(`select public.cfb_market_quarantine_quotes(${J([q450, q0])}, 'INGEST', '${now}')`));
  chk('the quarantine keeps a +450 spread and odds of 0 (service role)', qr.quarantined === 2 && qr.received === 2, qr);
  const rows = JSON.parse(one(`select json_agg(json_build_object('sev', severity, 'r', reasons, 'raw', raw is not null, 'id', quarantine_id) order by market_type) from public.cfb_market_quote_quarantine`));
  chk('each with its reasons, severity REJECT and the raw payload for investigation',
    rows.length === 2 && rows.every((x) => x.sev === 'REJECT' && x.raw && /^cfbz_[0-9a-f]{24}$/.test(x.id)) && rows.some((x) => x.r.includes('PRICE_ZERO')) && rows.some((x) => x.r.includes('SPREAD_OUT_OF_BOUNDS')), rows);
  const again = JSON.parse(one(`select public.cfb_market_quarantine_quotes(${J([q450, q0])}, 'INGEST', '${now}')`));
  chk('a replay is a no-op: one row per quote and stage', again.quarantined === 0 && again.duplicates === 2 && one('select count(*) from public.cfb_market_quote_quarantine') === '2', again);
  const clean = JSON.parse(one(`select public.cfb_market_quarantine_quotes(${J([Object.assign({}, base, { market_type: 'spread', home_line: -3.5, price_home: -110, price_away: -110 })])}, 'INGEST', '${now}')`));
  chk('a clean quote with no reasons is not quarantined', clean.clean === 1 && clean.quarantined === 0, clean);
  const outlier = JSON.parse(one(`select public.cfb_market_quarantine_quotes(${J([Object.assign({}, base, { market_type: 'spread', home_line: -17, price_home: -110, price_away: -110, observed_at: '2026-10-01T11:55:00.000Z', reasons: ['CROSS_BOOK_OUTLIER'], evidence: { peer_median: -3.5 } })])}, 'INGEST', '${now}')`));
  chk('a caller verdict (an outlier) is kept as QUARANTINE with its evidence', outlier.quarantined === 1
    && one(`select severity || '|' || (evidence ->> 'peer_median') from public.cfb_market_quote_quarantine where 'CROSS_BOOK_OUTLIER' = any(reasons)`) === 'QUARANTINE|-3.5');
  chk('quarantine rows are never updated', refused(`update public.cfb_market_quote_quarantine set reasons = array['X'];`, /append-only|permission denied/)
    && /append-only/.test(db.mustFail(() => db.sql(`update public.cfb_market_quote_quarantine set reasons = array['X'];`)) || ''));
  chk('quarantine rows are never deleted', refused(`delete from public.cfb_market_quote_quarantine;`, /append-only|permission denied/));
  chk('quarantine is never truncated (even by the owner)', /append-only/.test(db.mustFail(() => db.sql('truncate public.cfb_market_quote_quarantine')) || ''));

  /* ---- the checked ingest (it judges against the server clock) ------- */
  const REAL = Date.now(), live = { observed_at: new Date(REAL - 10 * 60000).toISOString(), kickoff_ts: new Date(REAL + 48 * 3600000).toISOString() };
  const good = Object.assign({}, base, live, { provider_event_id: 'ev2', market_type: 'spread', home_line: -6.5, price_home: -115, price_away: -105 });
  const bad = Object.assign({}, base, live, { provider_event_id: 'ev2', market_type: 'total', total_points: 0, price_over: -110, price_under: -110 });
  const ci = JSON.parse(one(`select public.cfb_market_ingest_quotes(${J([good, bad])})`));
  chk('checked ingest: the clean quote is forwarded to cfb_lab_ingest_quotes, the bad one quarantined', ci.forwarded === 1 && ci.quarantined === 1 && ci.lab && ci.lab.written === 1, ci);
  chk('and a total of 0 never reaches the market history', one(`select count(*) from public.cfb_lab_market_quotes where provider_event_id = 'ev2' and market_type = 'total'`) === '0'
    && one(`select count(*) from public.cfb_market_quote_quarantine where provider_event_id = 'ev2' and 'TOTAL_OUT_OF_BOUNDS' = any(reasons)`) === '1');

  /* ---- settlement safety -------------------------------------------- */
  const res = (id, o) => ins('cfb_lab_results', Object.assign({ result_id: 'cfbr_' + id.repeat(24), game_id: 'g' + id, status: 'FINAL', home_points: 30, away_points: 27,
    final_margin: 3, final_total: 57, overtime: null, sources: [{ source: 'espn' }], sources_agree: true, supersedes: null, reason: null }, o));
  chk('a valid FINAL is accepted', accepted(res('1', {})));
  chk('a tied FINAL is refused (college football has no ties)', refused(res('2', { home_points: 0, away_points: 0, final_margin: 0, final_total: 0 }), /tied|no ties/));
  chk('a FINAL above 150 points is refused', refused(res('3', { home_points: 200, away_points: 10, final_margin: 190, final_total: 210 }), /0\.\.150/));
  chk('a FINAL with a negative score is refused', refused(res('4', { home_points: -3, away_points: 10, final_margin: -13, final_total: 7 }), /0\.\.150/));
  chk('a FINAL without scores is refused', refused(res('5', { home_points: null, away_points: null, final_margin: null, final_total: null })));
  chk('a POSTPONED result needs no score (it is VOID, never a loss)', accepted(res('6', { status: 'POSTPONED', home_points: null, away_points: null, final_margin: null, final_total: null })));
  chk('a CANCELED result is accepted without a score', accepted(res('7', { status: 'CANCELED', home_points: null, away_points: null, final_margin: null, final_total: null })));
  chk('an overtime FINAL (a 7-point OT win) is accepted with the OT score', accepted(res('8', { home_points: 45, away_points: 38, final_margin: 7, final_total: 83, overtime: true })));
  chk('a result is never edited after settlement', refused(`update public.cfb_lab_results set home_points = 31 where game_id = 'g1';`, /append-only|permission denied/)
    && /append-only/.test(db.mustFail(() => db.sql(`update public.cfb_lab_results set home_points = 31 where game_id = 'g1';`)) || ''));

  /* ---- a wager is graded once --------------------------------------- */
  const ev = (id) => ins('cfb_lab_evaluations', { evaluation_id: 'cfbe_' + id.repeat(24), prediction_id: 'cfbp_' + 'a'.repeat(24), eval_version: 'cfb_lab_eval_v1', result_id: 'cfbr_' + '1'.repeat(24),
    close_line_id: 'cfbl_' + 'c'.repeat(24), evaluated_at: '2026-10-04T06:00:00.000Z', game_id: 'g1', model_version: 'm', checkpoint_type: 'T24', origin: 'LIVE', official: true, void: false });
  chk('an evaluation is accepted once', accepted(ev('1')));
  chk('the same (prediction, eval version, result, close) under another id is refused: never graded twice', refused(ev('2'), /duplicate key|graded_once/));

  /* ---- the frozen decision cannot move (a LIVE row is dated by the server clock) */
  const T0 = new Date(REAL - 3600000).toISOString(), KO = new Date(REAL + 20 * 3600000).toISOString();
  const P = { model_version: 'test_model_v1', model_label: 'T', engine_id: 't', projection_computed_at: T0, feature_ts: T0,
    feature_version: 'fv', calibration_version: 'cv', ensemble_version: 'ev', params_hash: 'ph',
    game: { game_id: 'g9', season: 2026, week: 6, home: 'Home U', away: 'Away St', home_id: 'h', away_id: 'a', neutral_site: false, kickoff: KO },
    pure: { margin: 4, total: 50, p_home: 0.6, sigma: 15, t_df: 100, intervals: { 50: [-6, 14], 80: [-15, 23], 95: [-25, 33] }, home_pts: 27, away_pts: 23, confidence_raw: 80, ens_sd: 1 },
    components: null, state: {}, explain: {}, slateGame: null, inputs: {} };
  const mk = L.marketAt([{ quote_id: 'q1', source: 'odds_api', book: 'dk', market_type: 'spread', home_line: -2.5, price_home: -110, price_away: -110, observed_at: new Date(REAL - 2 * 3600000).toISOString(), is_pregame: true }], T0, KO);
  const row = CP.buildRow(P, 'T24', true, mk, { status: 'LEAN', side: 'HOME', decision_source: 't', reason: 'r', cover_probability: 0.54 }, { status: 'GREEN', checks: [] },
    { now: T0, role: 'champion', origin: 'LIVE' });
  chk('a snapshot with its entry line and price is written', accepted(ins('cfb_lab_predictions', SY.shape('cfb_lab_predictions', row))));
  chk('later market information cannot change the entry line', refused(`update public.cfb_lab_predictions set recommended_line = -1.5 where prediction_id = '${row.prediction_id}';`, /append-only|permission denied/));
  chk('... nor the entry price', refused(`update public.cfb_lab_predictions set recommended_price = -105 where prediction_id = '${row.prediction_id}';`, /append-only|permission denied/));
  chk('... nor the decision', refused(`update public.cfb_lab_predictions set decision_class = 'BET' where prediction_id = '${row.prediction_id}';`, /append-only|permission denied/)
    && /append-only/.test(db.mustFail(() => db.sql(`update public.cfb_lab_predictions set decision_class = 'BET' where prediction_id = '${row.prediction_id}';`)) || ''));
  chk('... and the snapshot cannot be deleted', refused(`delete from public.cfb_lab_predictions where prediction_id = '${row.prediction_id}';`, /append-only|permission denied/)
    && /append-only/.test(db.mustFail(() => db.sql(`delete from public.cfb_lab_predictions where prediction_id = '${row.prediction_id}';`)) || ''));

  /* ---- line corrections --------------------------------------------- */
  const corr = (o) => ins('cfb_market_line_corrections', Object.assign({ correction_id: 'cfbk_' + 'e'.repeat(24), line_id: 'cfbl_' + 'c'.repeat(24), game_id: 'g1', kind: 'OPEN', book: 'CONSENSUS',
    market_type: 'spread', version: 1, original: { home_line: -3 }, corrected: { home_line: -3.5 }, reason: 'provider re-stated its opener on 10-02', actor: 'ops', created_at: '2026-10-05T12:00:00.000Z' }, o));
  chk('a correction without a real reason is refused', refused(corr({ reason: 'oops' })));
  chk('an audited opener correction is kept as a new version', accepted(corr({})));
  chk('a correction is never edited', /append-only/.test(db.mustFail(() => db.sql(`update public.cfb_market_line_corrections set reason = 'something else entirely';`)) || ''));

  /* ---- the guarded role change ------------------------------------------ */
  db.service(ins('cfb_lab_model_roles', { event_id: 'cfbg_' + '1'.repeat(24), model_version: 'edgedesk_cfb_p4_v1.0.0', model_label: 'V1', role: 'champion', effective_at: '2026-09-27T12:00:00.000Z', reason: 'seed', actor: 'seed' }));
  db.service(ins('cfb_lab_model_roles', { event_id: 'cfbg_' + '2'.repeat(24), model_version: 'edgedesk_cfb_v2.1.0', model_label: 'V2.1', role: 'challenger', effective_at: '2026-09-27T12:00:00.000Z', reason: 'seed', actor: 'seed' }));
  const role = (m, r, reason, actor, confirm) => `select public.cfb_market_admin_set_role('${m}', null, '${r}', ${reason === null ? 'null' : "'" + reason + "'"}, '${actor}', ${confirm === null ? 'null' : "'" + confirm + "'"})`;
  chk('promotion without retyping the version is refused (one accidental click)', refused(role('edgedesk_cfb_v2.1.0', 'champion', 'promotion.json ELIGIBLE on 163 games', 'ops', null), /repeat the model version/));
  chk('a typo in the version is refused (confirm must match)', refused(role('edgedesk_cfb_v2.1.0', 'champion', 'promotion.json ELIGIBLE on 163 games', 'ops', 'edgedesk_cfb_v2.1.O'), /repeat the model version/));
  chk('an unregistered model cannot be promoted', refused(role('edgedesk_cfb_v9.9.9', 'champion', 'promotion.json ELIGIBLE on 163 games', 'ops', 'edgedesk_cfb_v9.9.9'), /not registered/));
  chk('a promotion without a reason is refused', refused(role('edgedesk_cfb_v2.1.0', 'champion', 'ok', 'ops', 'edgedesk_cfb_v2.1.0'), /reason/));
  chk('the champion cannot be retired directly', refused(role('edgedesk_cfb_p4_v1.0.0', 'retired', 'retiring the old champion now', 'ops', 'edgedesk_cfb_p4_v1.0.0'), /cannot be retired directly/));
  const okRole = JSON.parse(one(role('edgedesk_cfb_v2.1.0', 'champion', 'promotion.json ELIGIBLE on 163 games', 'ops', 'edgedesk_cfb_v2.1.0')));
  chk('a confirmed, reasoned promotion goes through cfb_lab_set_role (old champion demoted, audited)', okRole.ok === true && okRole.changed === true && (okRole.demoted || []).includes('edgedesk_cfb_p4_v1.0.0'), okRole);

  /* ---- the BET-volume view ------------------------------------------- */
  chk('the BET-volume view reads for authenticated', /edgedesk|test_model|^\s*$/.test(db.as('00000000-0000-0000-0000-000000000001', 'select model_version from public.cfb_market_bet_volume;')));

  /* ---- who can do what ------------------------------------------------ */
  const denied = (f) => /permission denied/.test(db.mustFail(() => f()) || '');
  chk('anon cannot call the quarantine, the checked ingest or the role change', denied(() => db.anon(`select public.cfb_market_quarantine_quotes('[]'::jsonb)`))
    && denied(() => db.anon(`select public.cfb_market_ingest_quotes('[]'::jsonb)`)) && denied(() => db.anon(role('x_model', 'candidate', 'a reason long enough', 'ops', 'x_model'))));
  chk('authenticated cannot call them either', denied(() => db.as('00000000-0000-0000-0000-000000000001', `select public.cfb_market_quarantine_quotes('[]'::jsonb)`))
    && denied(() => db.as('00000000-0000-0000-0000-000000000001', `select public.cfb_market_ingest_quotes('[]'::jsonb)`)));
  chk('anon reads neither the quarantine nor the corrections', denied(() => db.anon('select count(*) from public.cfb_market_quote_quarantine')) && denied(() => db.anon('select count(*) from public.cfb_market_line_corrections')));
  chk('authenticated reads the quarantine and cannot write it', /^\d+$/.test(db.as('00000000-0000-0000-0000-000000000001', 'select count(*) from public.cfb_market_quote_quarantine;').trim())
    && denied(() => db.as('00000000-0000-0000-0000-000000000001', ins('cfb_market_quote_quarantine', { quarantine_id: 'cfbz_' + 'f'.repeat(24), stage: 'INGEST', severity: 'REJECT', reasons: ['X'], rule_version: 'r', detected_at: now }))));
} catch (e) {
  chk('the live layer ran without an unexpected error', false, String(e.message || e).slice(0, 600));
}
done(null, db);
