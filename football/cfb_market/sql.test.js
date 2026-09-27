#!/usr/bin/env node
/* ===========================================================================
   supabase/cfb_market.sql against a real, throwaway PostgreSQL.

   Checks: applies clean, twice, and as one transaction; append-only for every
   role; a snapshot / event / prediction after kickoff is refused; the sign
   (consensus_margin = -median_home_line); integrity.js's actionable codes
   only; impossible prices refused; one snapshot per game x moment x rule;
   mythology refused ("sharp money", "steam", a cause); an information event
   records timing, never CAUSED; the challenger is never labelled pure or the
   fair line; book quality is fit on development seasons only; a provider
   conflict preserves both feeds; public betting data can never be used by a
   decision; the Model Lab panel; the canonical-quote view appears only with
   the Lab's quote table and renders HOME MARGIN; authenticated reads, anon
   nothing; and the runner's rows (football/cfb_market/run.js plan) insert as
   PostgREST would.

   Run: node football/cfb_market/sql.test.js   (CFB_MARKET_SQL_REQUIRED=1 in CI)
   =========================================================================== */
'use strict';
const path = require('path');
const PG = require('../../tools/personal/_pg.js');
const RUN = require('./run.js');

const SQL = path.join(__dirname, '..', '..', 'supabase', 'cfb_market.sql');
const LAB_SQL = path.join(__dirname, '..', '..', 'supabase', 'cfb_lab.sql');
let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function done(note) {
  if (note && /^SKIP/.test(note) && process.env.CFB_MARKET_SQL_REQUIRED === '1') { fail++; failures.push({ name: 'Postgres required but ' + note }); }
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
  if (note) console.log(note);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
const db = PG.start('cfbmarket');
if (!db || db.skip) done('SKIP | ' + ((db && db.skip) || 'no postgres') + ' — the SQL layer did not run');

const J = (o) => '$j$' + JSON.stringify(o) + '$j$::jsonb';
const ins = (table, row) => `insert into public.${table} select * from jsonb_populate_record(jsonb_populate_record(null::public.${table}, jsonb_build_object('recorded_at', now())), ${J(row)});`;
const hex = (c) => c.repeat(24);
const refused = (sql, re) => (re || /check constraint|violates/i).test(db.mustFail(() => db.service(sql)) || '');
const accepted = (sql) => !db.mustFail(() => db.service(sql));

try {
  const r1 = db.applyFile(SQL);
  chk('applies to a clean database, every report row ok', !/CHECK THIS/.test(r1) && (r1.match(/\|ok/g) || []).length >= 9, r1.slice(-600));
  chk('applies a second time, still ok', !/CHECK THIS/.test(db.applyFile(SQL)));
  chk('applies as ONE transaction, still ok', !/CHECK THIS/.test(db.applyFileAtomic(SQL)));
  chk('without the Lab quote table, no canonical-quote view (no dependency)', db.sql(`select to_regclass('public.cfb_market_quotes_canonical') is null`) === 't');

  const snap = { snapshot_id: 'cfbms_' + hex('1'), rule_version: 'cfb_market_snapshot_v1', game_id: 'G1', season: 2026, week: 5,
    as_of: '2026-10-01T14:00:00.000Z', kickoff_ts: '2026-10-03T19:30:00.000Z', n_books_seen: 4, n_active_books: 3, stale_book_count: 1,
    integrity_excluded_count: 0, median_home_line: -3, weighted_median_home_line: -3, mean_home_line: -3.167, trimmed_mean_home_line: -3.167,
    consensus_margin: 3, consensus_uncertainty: 0.435, dispersion_iqr: 0.25, dispersion_sd: 0.289, best_home_book: 'mgm', best_home_line: -3,
    best_home_price: -105, best_away_book: 'fd', best_away_line: 3.5, best_away_price: -110, median_price_home: -110, median_price_away: -110,
    integrity_status: 'OK', actionable_status: 'ACTIONABLE', quote_ids: ['q1', 'q2', 'q3'], payload: {} };
  chk('a consensus snapshot is accepted', accepted(ins('cfb_market_consensus_snapshots', snap)));
  const v = (o, k) => ins('cfb_market_consensus_snapshots', Object.assign({}, snap, { snapshot_id: 'cfbms_' + hex(k), as_of: '2026-10-01T15:0' + (k.charCodeAt(0) % 10) + ':00.000Z' }, o));
  chk('a snapshot at or after kickoff is refused', refused(v({ as_of: '2026-10-03T19:30:00.000Z' }, 'a')));
  chk('a snapshot whose margin is not -home line is refused (the one sign conversion)', refused(v({ consensus_margin: -3 }, 'b')));
  chk('an actionable code integrity.js does not define is refused', refused(v({ actionable_status: 'MARKET_DATA_STALE' }, 'c')));
  chk('an impossible American price is refused', refused(v({ best_home_price: -50 }, 'd')));
  chk('more active books than books seen is refused', refused(v({ n_active_books: 5 }, 'e')));
  chk('the same game x moment x rule twice is refused', refused(ins('cfb_market_consensus_snapshots', Object.assign({}, snap, { snapshot_id: 'cfbms_' + hex('z') })), /duplicate key|unique/i));
  for (const [op, sql] of [['update', `update public.cfb_market_consensus_snapshots set median_home_line = -4;`], ['delete', `delete from public.cfb_market_consensus_snapshots;`],
    ['truncate', `truncate public.cfb_market_consensus_snapshots;`]]) {
    chk('append-only: ' + op + ' is refused for the service role', /append-only|permission denied/i.test(db.mustFail(() => db.service(sql)) || ''));
    chk('append-only: ' + op + ' is refused for the owner', /append-only/i.test(db.mustFail(() => db.sql(sql)) || ''));
  }

  const ev = { event_id: 'cfbmv_' + hex('1'), game_id: 'G1', event_type: 'MARKET_MOVES_TOWARD_MODEL', at: '2026-10-01T15:00:00.000Z',
    kickoff_ts: '2026-10-03T19:30:00.000Z', rule_version: 'cfb_market_snapshot_v1', detail: { from: 3, to: 4 } };
  chk('a market event is accepted', accepted(ins('cfb_market_events', ev)));
  const e = (o, k) => ins('cfb_market_events', Object.assign({}, ev, { event_id: 'cfbmv_' + hex(k), at: '2026-10-01T16:0' + (k.charCodeAt(0) % 10) + ':00.000Z' }, o));
  chk('an event that says "sharp money" is refused (no internet mythology in a database field)', refused(e({ detail: { note: 'sharp money on the home side' } }, 'a')));
  chk('an event that says "steam" is refused', refused(e({ detail: { note: 'a steam move' } }, 'b')));
  chk('an event that claims a cause is refused', refused(e({ detail: { note: 'caused by the QB news' } }, 'c')));
  chk('an unknown event type (e.g. SHARP_ACTION) is refused', refused(e({ event_type: 'SHARP_ACTION' }, 'd')));
  chk('an event at or after kickoff is refused', refused(e({ at: '2026-10-03T20:00:00.000Z' }, 'f')));
  chk('measurable words are accepted ("books moved together")', accepted(e({ event_type: 'COORDINATED_MOVE', detail: { label: 'books moved together', books: 3 } }, 'g')));

  const bq = { book_quality_id: 'cfbbq_' + hex('1'), artifact_version: 'cfb_market_book_quality_v1', book: 'pinnacle', family: 'pinnacle',
    market_information_weight: 0.09, consensus_weight: 1.0, stale_or_outlier_rate: 0.019, hold: 0.03, fit_seasons: [2016, 2017, 2018, 2019], weights_active: false, payload: {} };
  chk('a book-quality row fit on development seasons is accepted', accepted(ins('cfb_book_quality', bq)));
  chk('book quality fit on a holdout season is refused', refused(ins('cfb_book_quality', Object.assign({}, bq, { book_quality_id: 'cfbbq_' + hex('2'), book: 'x', fit_seasons: [2019, 2024] }))));
  chk('a negative information weight is refused', refused(ins('cfb_book_quality', Object.assign({}, bq, { book_quality_id: 'cfbbq_' + hex('3'), book: 'y', market_information_weight: -0.1 }))));

  const pr = { prediction_id: 'cfbmp_' + hex('1'), game_id: 'G1', kind: 'MARKET_ADJUSTED_PROJECTION', as_of: '2026-10-01T15:00:00.000Z',
    kickoff_ts: '2026-10-03T19:30:00.000Z', model_version: 'cfb_market_challenger_v1', role: 'challenger', value: 3.73, uncertainty: null,
    label: 'CHALLENGER (Model Lab only): not the EdgeDesk fair line', payload: {} };
  chk('a challenger margin is accepted', accepted(ins('cfb_market_predictions', Object.assign({}, pr, { label: 'CHALLENGER (Model Lab only)' }))));
  chk('a challenger labelled as the fair line is refused', refused(ins('cfb_market_predictions', Object.assign({}, pr, { prediction_id: 'cfbmp_' + hex('2'), as_of: '2026-10-01T15:01:00.000Z', label: 'EdgeDesk fair line' }))));
  chk('a market prediction can never be role pure', refused(ins('cfb_market_predictions', Object.assign({}, pr, { prediction_id: 'cfbmp_' + hex('3'), as_of: '2026-10-01T15:02:00.000Z', role: 'pure', label: 'x' }))));
  chk('a prediction after kickoff is refused', refused(ins('cfb_market_predictions', Object.assign({}, pr, { prediction_id: 'cfbmp_' + hex('4'), kind: 'EXPECTED_CLOSE_MARGIN', role: 'research', label: 'expected close', as_of: '2026-10-04T00:00:00.000Z' }))));

  const pc = { conflict_id: 'cfbpc_' + hex('1'), game_id: 'G1', book: 'draftkings', sources: ['espn', 'odds_api'], quote_ids: ['q1', 'q2'], lines: [-3, -4],
    difference_pts: 1, major: true, likely_fresher: 'odds_api', action: 'PRESERVE_BOTH', detected_at: '2026-10-01T15:00:00.000Z' };
  chk('a provider conflict preserves both feeds', accepted(ins('cfb_market_provider_conflicts', pc)));
  chk('a conflict "resolved" by overwriting is refused', refused(ins('cfb_market_provider_conflicts', Object.assign({}, pc, { conflict_id: 'cfbpc_' + hex('2'), action: 'OVERWRITE' }))));

  const ie = { info_event_id: 'cfbie_' + hex('1'), game_id: 'G1', event_type: 'QB_RULED_OUT', event_at: '2026-10-01T15:00:00.000Z', market_before: 3,
    market_before_at: '2026-10-01T14:00:00.000Z', market_after: 1, market_after_at: '2026-10-01T15:30:00.000Z', move_pts: -2, attribution: 'TIMING_CONSISTENT', detail: {} };
  chk('an information event with its timing is accepted', accepted(ins('cfb_market_information_events', ie)));
  chk('an information event can never be CAUSED', refused(ins('cfb_market_information_events', Object.assign({}, ie, { info_event_id: 'cfbie_' + hex('2'), attribution: 'CAUSED' }))));
  chk('"market after" before the event is refused', refused(ins('cfb_market_information_events', Object.assign({}, ie, { info_event_id: 'cfbie_' + hex('3'), market_after_at: '2026-10-01T14:30:00.000Z' }))));

  const pb = { split_id: 'cfbpb_' + hex('1'), game_id: 'G1', source: 'x', observed_at: '2026-10-01T15:00:00.000Z', ticket_pct_home: 72, money_pct_home: 55, coverage: 'one source', decision_use: false };
  chk('public betting data is stored as experimental', accepted(ins('cfb_market_public_betting', pb)));
  chk('public betting data can never be marked for decision use', refused(ins('cfb_market_public_betting', Object.assign({}, pb, { split_id: 'cfbpb_' + hex('2'), decision_use: true }))));

  chk('the Model Lab panel shows current, open and movement since open',
    accepted(ins('cfb_market_consensus_snapshots', Object.assign({}, snap, { snapshot_id: 'cfbms_' + hex('9'), as_of: '2026-10-02T14:00:00.000Z', median_home_line: -4,
      weighted_median_home_line: -4, consensus_margin: 4 })))
    && db.sql(`select current_home_line || '|' || open_home_line || '|' || movement_since_open || '|' || moves_toward_model from public.cfb_market_lab_panel where game_id = 'G1'`) === '-4.00|-3.00|1.00|1');

  chk('authenticated reads the market tables', db.as('00000000-0000-0000-0000-000000000001', `select count(*) from public.cfb_market_consensus_snapshots;`) === '2');
  chk('anon reads nothing', /permission denied/i.test(db.mustFail(() => db.anon(`select count(*) from public.cfb_market_consensus_snapshots;`)) || '')
    && /permission denied/i.test(db.mustFail(() => db.anon(`select count(*) from public.cfb_market_lab_panel;`)) || ''));

  /* the canonical-quote view over the Lab's quote store */
  db.applyFile(LAB_SQL);
  chk('with the Lab quote table, the canonical-quote view appears on re-apply', !/CHECK THIS/.test(db.applyFile(SQL)) && db.sql(`select to_regclass('public.cfb_market_quotes_canonical') is not null`) === 't');
  const q = { source: 'espn', book: 'draftkings', game_id: 'G1', provider_event_id: 'G1', market_type: 'spread', home_line: -4.5, price_home: -110, price_away: -110,
    observed_at: '2026-10-01T14:00:00.000Z', kickoff_ts: '2026-10-03T19:30:00.000Z', is_pregame: true, is_provider_open: false, is_provider_close: false,
    home_team: 'Texas Tech', away_team: 'Baylor', retrieved_at: '2026-10-01T14:00:00.000Z' };
  db.service(`select public.cfb_lab_ingest_quotes(${J([q])});`);
  const rows = db.sql(`select side || '|' || line || '|' || home_market_margin || '|' || round(decimal_odds, 4) || '|' || round(implied_probability_raw, 4)
    from public.cfb_market_quotes_canonical where game_id = 'G1' order by side`).split('\n');
  chk('canonical view: Texas Tech -4.5 at home is home_market_margin +4.5 for BOTH sides; away +4.5 is the same state',
    rows.length === 2 && rows[0] === 'AWAY|4.50|4.50|1.9091|0.5238' && rows[1] === 'HOME|-4.50|4.50|1.9091|0.5238', rows);

  /* the runner's rows insert as PostgREST would insert them */
  const P = RUN.plan(2026, '2026-12-31T00:00:00.000Z');
  const bad = [];
  let tried = 0;
  for (const x of P.filter((y) => y.rows.length)) {
    const batch = x.rows.slice(0, 40);
    tried += batch.length;
    const err = db.mustFail(() => db.service(batch.map((row) => ins(x.table, row)).join('\n')));
    if (err && !/duplicate key/.test(err)) bad.push({ table: x.table, error: err.slice(0, 240) });
  }
  chk('the runner\'s rows (' + tried + ') insert as PostgREST would insert them', !bad.length, bad);
} finally {
  db.stop();
}
done();
