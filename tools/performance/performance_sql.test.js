#!/usr/bin/env node
'use strict';
/* ===========================================================================
   supabase/model_performance.sql against a REAL PostgreSQL, as every reader.

     STATIC   no psql meta-commands, additive only, ends in a report, small
              enough to paste, the rollback drops only its own objects
     APPLY    twice (idempotent), every report row ok
     INGEST   committed ledger rows through perf_ingest() as the service role;
              the same rows again add nothing (a job run twice); a row that
              does not follow the stored chain, or a chain that does not start
              at GENESIS, is refused; a capture at or after the start is
              refused; a 0-0 final is refused; the receipt time is the server's
     APPEND   UPDATE, DELETE and TRUNCATE refused for the service role and the
              owner alike
     READ     anon and a signed-in reader see results and grades, and only the
              forecasts of games that have started; neither can write, ingest,
              read the ingest log or call perf_heads
     ROLLBACK drops exactly this file's objects; the file applies again after

   Run: node tools/performance/performance_sql.test.js
   CI sets PERF_SQL_REQUIRED=1 so a missing PostgreSQL fails instead of skipping.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const SYNC = require('./sync.js');

const ROOT = path.join(__dirname, '..', '..');
const FILE = path.join(ROOT, 'supabase', 'model_performance.sql');
const RB = path.join(ROOT, 'supabase', 'model_performance_rollback.sql');
const T = PG.kit('model performance SQL');
const lit = PG.lit;

/* STATIC */
const SQL = fs.readFileSync(FILE, 'utf8');
const RSQL = fs.readFileSync(RB, 'utf8');
T.chk('S no psql meta-commands', !/^\s*\\/m.test(SQL) && !/^\s*\\/m.test(RSQL));
T.chk('S additive: no DROP TABLE, no TRUNCATE, no DELETE FROM in the contract', !/\bdrop\s+table\b/i.test(SQL) && !/\btruncate\s+(table\s+)?public\./i.test(SQL) && !/\bdelete\s+from\b/i.test(SQL));
T.chk('S every table is create-if-not-exists', (SQL.match(/create table /gi) || []).length === (SQL.match(/create table if not exists /gi) || []).length);
T.chk('S ends in the report', /-- THE REPORT\.[\s\S]*select[\s\S]*;\s*$/.test(SQL) && /-- THE REPORT\.[\s\S]*;\s*$/.test(RSQL));
T.chk('S small enough to paste into the SQL editor (≤ 18000 bytes)', Buffer.byteLength(SQL) <= 18000, Buffer.byteLength(SQL));
T.chk('S the rollback drops only perf_ objects', (RSQL.match(/drop (table|function|view) if exists public\.(\w+)/gi) || []).every((d) => /public\.perf_/.test(d)) && /drop table if exists public\.perf_forecasts/.test(RSQL));

const db = PG.start('perfsql');
if (db.skip) {
  if (process.env.PERF_SQL_REQUIRED === '1') T.chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — the live layer did not run');
  process.exit(T.done());
}
const ok = (out) => !/CHECK THIS/.test(out) && /\bok\b/.test(out);
const one = (s) => String(s).trim();
function ingest(kind, rows, as) {
  const q = 'select public.perf_ingest(' + lit(kind) + ', ' + lit(JSON.stringify(rows)) + '::jsonb, ' + lit('test') + ', null);';
  return JSON.parse((as || db.service)(q));
}
try {
  /* APPLY */
  let out = db.applyFileAtomic(FILE);
  T.chk('A the contract applies (as one transaction) and its report is all ok', ok(out), out.slice(0, 600));
  out = db.applyFile(FILE);
  T.chk('A …and applies again (idempotent)', ok(out), out.slice(0, 600));

  /* INGEST real committed ledger rows */
  const fRows = SYNC.pending(ROOT, 'forecasts', {}).filter((r) => r.ledger_file === 'performance/ledger/forecasts/nfl-2026.jsonl').slice(0, 40);
  const rRows = SYNC.pending(ROOT, 'results', {}).filter((r) => r.ledger_file === 'performance/ledger/results/nfl-2026.jsonl').slice(0, 20);
  const gRows = SYNC.pending(ROOT, 'grades', {}).filter((r) => r.ledger_file === 'performance/ledger/grades/nfl-2026.jsonl').slice(0, 20);
  T.chk('I the committed ledger has rows to mirror', fRows.length === 40 && rRows.length === 20 && gRows.length === 20, [fRows.length, rRows.length, gRows.length]);
  let r = ingest('forecasts', fRows);
  T.chk('I forecasts ingest', r.received === 40 && r.inserted === 40, r);
  r = ingest('results', rRows); T.chk('I results ingest', r.inserted === 20, r);
  r = ingest('grades', gRows); T.chk('I grades ingest', r.inserted === 20, r);
  r = ingest('forecasts', fRows);
  T.chk('I the same rows again add nothing (a duplicate job run)', r.received === 40 && r.inserted === 0 && r.already_present === 40, r);
  T.chk('I every ingest is logged, server-side', one(db.sql('select count(*) from public.perf_ingest_runs;')) === '4');
  const heads = JSON.parse(db.service('select public.perf_heads();'));
  T.chk('I perf_heads says where each file stands', heads['forecasts|performance/ledger/forecasts/nfl-2026.jsonl'] === 40, heads);
  T.chk('I a sync from those heads sends only what is new', SYNC.pending(ROOT, 'forecasts', heads).filter((x) => x.ledger_file === 'performance/ledger/forecasts/nfl-2026.jsonl').every((x) => x.seq > 40));

  /* the chain */
  const next = SYNC.pending(ROOT, 'forecasts', heads).filter((x) => x.ledger_file === 'performance/ledger/forecasts/nfl-2026.jsonl')[0];
  if (next) {
    const forged = Object.assign({}, next, { prev: 'f'.repeat(64) });
    T.chk('I a row that does not follow the stored chain is refused', /does not follow the stored chain/.test(db.mustFail(() => ingest('forecasts', [forged])) || ''));
  }
  const g1 = Object.assign({}, fRows[0], { hash: 'a'.repeat(64), ledger_file: 'performance/ledger/forecasts/test-2099.jsonl', prev: 'b'.repeat(64) });
  T.chk('I a chain must start at GENESIS', /must start the chain/.test(db.mustFail(() => ingest('forecasts', [g1])) || ''));

  /* pregame: a capture at or after the start is refused */
  const base = JSON.parse(JSON.stringify(fRows[0]));
  const late = Object.assign({}, base, { hash: 'c'.repeat(64), ledger_file: 'performance/ledger/forecasts/late-2099.jsonl', seq: 1, prev: 'GENESIS', start_utc: '2026-09-01T00:00:00Z' });
  late.row = Object.assign({}, base.row, { capture: Object.assign({}, base.row.capture, { method: 'ledger_capture', captured_at: '2026-09-01T00:05:00Z' }), model: Object.assign({}, base.row.model, { predicted_at: '2026-08-31T00:00:00Z' }) });
  T.chk('I a forecast captured after the start is refused', /perf_forecasts_pregame/.test(db.mustFail(() => ingest('forecasts', [late])) || ''));

  /* a future game, captured pregame: stored, but not readable until it starts */
  const future = Object.assign({}, base, { hash: 'd'.repeat(64), ledger_file: 'performance/ledger/forecasts/future-2099.jsonl', seq: 1, prev: 'GENESIS', start_utc: '2099-01-01T00:00:00Z', event_key: 'NFL|FUTURE' });
  future.row = Object.assign({}, base.row, { capture: Object.assign({}, base.row.capture, { method: 'ledger_capture', captured_at: '2026-10-16T00:00:00Z', recorded_at: null }), model: Object.assign({}, base.row.model, { predicted_at: '2026-10-15T00:00:00Z' }) });
  r = ingest('forecasts', [future]);
  T.chk('I a pregame capture of a future game is stored, tier VERIFIED', r.inserted === 1 && one(db.sql("select tier from public.perf_forecasts where event_key = 'NFL|FUTURE';")) === 'VERIFIED');
  /* the receipt time is the server's: a caller cannot backdate it */
  db.sql("set session_replication_role = default;");
  const stampOk = one(db.sql("select abs(extract(epoch from (server_recorded_at - now()))) < 600 from public.perf_forecasts where event_key = 'NFL|FUTURE';"));
  T.chk('I server_recorded_at is the server clock', stampOk === 't');
  const direct = db.mustFail(() => db.service("insert into public.perf_forecasts (hash, ledger_file, seq, prev, event_key, sport, start_utc, tier, method, row, server_recorded_at) values ("
    + lit('e'.repeat(64)) + ", 'x', 1, 'GENESIS', 'X|1', 'nfl', '2099-01-01', 'RECORDED', 'import:x', '{}', '2000-01-01');"));
  const backdated = one(db.sql("select count(*) from public.perf_forecasts where server_recorded_at < '2001-01-01';"));
  T.chk('I the service role cannot write around perf_ingest (no direct INSERT)', /permission denied/.test(direct || ''), direct);
  T.chk('I a backdated server_recorded_at never lands', backdated === '0', direct);

  /* results: a 0-0 final is a placeholder, not a final */
  const rr = JSON.parse(JSON.stringify(rRows[0]));
  const zero = Object.assign({}, rr, { hash: 'f1'.repeat(32), ledger_file: 'performance/ledger/results/zero-2099.jsonl', seq: 1, prev: 'GENESIS' });
  zero.row = Object.assign({}, rr.row, { home_score: 0, away_score: 0, state: 'FINAL', revision: 1, supersedes: null });
  T.chk('R a 0-0 final is refused', /perf_results_final_scores/.test(db.mustFail(() => ingest('results', [zero])) || ''));
  const rev = Object.assign({}, rr, { hash: 'f2'.repeat(32), ledger_file: 'performance/ledger/results/rev-2099.jsonl', seq: 1, prev: 'GENESIS' });
  rev.row = Object.assign({}, rr.row, { revision: 2, supersedes: null });
  T.chk('R a revision past 1 must name what it supersedes', /perf_results_revision/.test(db.mustFail(() => ingest('results', [rev])) || ''));

  /* APPEND-ONLY, for every role */
  ['perf_forecasts', 'perf_results', 'perf_grades', 'perf_ingest_runs'].forEach((t) => {
    T.chk('P ' + t + ': the service role cannot UPDATE', !!db.mustFail(() => db.service('update public.' + t + ' set ' + (t === 'perf_ingest_runs' ? 'kind' : 'event_key') + " = 'x';")));
    T.chk('P ' + t + ': the service role cannot DELETE', !!db.mustFail(() => db.service('delete from public.' + t + ';')));
    T.chk('P ' + t + ': even the owner cannot DELETE', /append-only/.test(db.mustFail(() => db.sql('delete from public.' + t + ';')) || ''));
    T.chk('P ' + t + ': even the owner cannot TRUNCATE', /append-only/.test(db.mustFail(() => db.sql('truncate public.' + t + ';')) || ''));
  });

  /* READ */
  const nF = one(db.sql('select count(*) from public.perf_forecasts;'));
  const anonF = one(db.anon('select count(*) from public.perf_forecasts;'));
  T.chk('R anon reads the forecasts of started games, not the future one', +anonF === +nF - 1, { all: nF, anon: anonF });
  T.chk('R anon cannot see the future forecast', one(db.anon("select count(*) from public.perf_forecasts where event_key = 'NFL|FUTURE';")) === '0');
  T.chk('R a signed-in reader cannot either', one(db.as('00000000-0000-0000-0000-000000000001', "select count(*) from public.perf_forecasts where event_key = 'NFL|FUTURE';")) === '0');
  T.chk('R anon reads results and grades', one(db.anon('select count(*) from public.perf_results;')) === '20' && one(db.anon('select count(*) from public.perf_grades;')) === '20');
  T.chk('R the attestation view answers anon, for started games', +one(db.anon('select count(*) from public.perf_forecast_attestation where server_pregame is not null;')) === +nF - 1);
  T.chk('R anon cannot read the ingest log', !!db.mustFail(() => db.anon('select count(*) from public.perf_ingest_runs;')));
  T.chk('R a signed-in reader cannot read the ingest log', !!db.mustFail(() => db.as('00000000-0000-0000-0000-000000000001', 'select count(*) from public.perf_ingest_runs;')));
  T.chk('W anon cannot insert', !!db.mustFail(() => db.anon("insert into public.perf_results (hash, ledger_file, seq, prev, event_key, sport, state, revision, reason, row) values (" + lit('9'.repeat(64)) + ", 'x', 1, 'GENESIS', 'X', 'nfl', 'VOID', 1, 'x', '{}');")));
  T.chk('W anon cannot call perf_ingest', /permission denied/.test(db.mustFail(() => ingest('forecasts', fRows.slice(0, 1), db.anon)) || ''));
  T.chk('W a signed-in reader cannot call perf_ingest', /permission denied/.test(db.mustFail(() => ingest('forecasts', fRows.slice(0, 1), (q) => db.as('00000000-0000-0000-0000-000000000001', q))) || ''));
  T.chk('W anon cannot call perf_heads', /permission denied/.test(db.mustFail(() => db.anon('select public.perf_heads();')) || ''));
  T.chk('W a signed-in reader cannot update a grade', !!db.mustFail(() => db.as('00000000-0000-0000-0000-000000000001', "update public.perf_grades set reason = 'x';")));

  /* ROLLBACK */
  out = db.applyFile(RB);
  T.chk('B the rollback removes exactly its objects', ok(out) && one(db.sql("select count(*) from pg_class where relname like 'perf\\_%' escape '\\';")) === '0', out);
  out = db.applyFile(FILE);
  T.chk('B the contract applies again after a rollback', ok(out), out.slice(0, 400));
} catch (e) {
  T.chk('the run completed', false, String(e.message).slice(0, 900));
} finally { db.stop(); }
process.exit(T.done());
