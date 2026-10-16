#!/usr/bin/env node
'use strict';
/* ===========================================================================
   supabase/research_grades.sql against a REAL PostgreSQL, as every reader.

     STATIC   no psql meta-commands, additive only, ends in a report, small
              enough to paste, the rollback drops only its own objects
     APPLY    twice (idempotent), every report row ok; beside
              model_performance.sql, and each rolls back without the other
     INGEST   ledger rows the hourly job itself wrote (a throwaway lifecycle:
              graded twice pregame, settled) through perf_research_ingest() as
              the service role; the same rows again add nothing; a broken
              chain, a chain not at GENESIS, a grade captured after its start,
              a letter that is not its score's, an outcome naming no stored
              grade, a grade made after the start, or a relabelled letter is
              refused; the receipt time is the server's
     APPEND   UPDATE, DELETE and TRUNCATE refused for the service role and the
              owner alike
     READ     anon and a signed-in reader see outcomes and the aggregate, and
              only the grades of games that have started; neither can write,
              ingest, read the ingest log or call the heads
     AGG      perf_grade_performance equals EDGRADE.performance on the same rows
     ROLLBACK drops exactly this file's objects; the file applies again after

   Run: node tools/performance/research_grades_sql.test.js
   CI sets PERF_SQL_REQUIRED=1 so a missing PostgreSQL fails instead of skipping.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const SYNC = require('./sync.js');
const F = require('./grade_fixture.js');
const G = require('../../lib/edgedesk_research_grade.js');
const GB = require('./grade_build.js');

const ROOT = path.join(__dirname, '..', '..');
const FILE = path.join(ROOT, 'supabase', 'research_grades.sql');
const RB = path.join(ROOT, 'supabase', 'research_grades_rollback.sql');
const PERF = path.join(ROOT, 'supabase', 'model_performance.sql');
const PERF_RB = path.join(ROOT, 'supabase', 'model_performance_rollback.sql');
const T = PG.kit('research grade SQL');
const lit = PG.lit;

/* STATIC */
const SQL = fs.readFileSync(FILE, 'utf8');
const RSQL = fs.readFileSync(RB, 'utf8');
T.chk('S no psql meta-commands', !/^\s*\\/m.test(SQL) && !/^\s*\\/m.test(RSQL));
T.chk('S additive: no DROP TABLE, no TRUNCATE, no DELETE FROM in the contract', !/\bdrop\s+table\b/i.test(SQL) && !/\btruncate\s+(table\s+)?public\./i.test(SQL) && !/\bdelete\s+from\b/i.test(SQL));
T.chk('S every table is create-if-not-exists', (SQL.match(/create table /gi) || []).length === (SQL.match(/create table if not exists /gi) || []).length);
T.chk('S ends in the report', /-- THE REPORT\.[\s\S]*select[\s\S]*;\s*$/.test(SQL) && /-- THE REPORT\.[\s\S]*;\s*$/.test(RSQL));
T.chk('S small enough to paste into the SQL editor (≤ 18000 bytes)', Buffer.byteLength(SQL) <= 18000, Buffer.byteLength(SQL));
T.chk('S the rollback drops only this file\'s objects', (RSQL.match(/drop (table|function|view) if exists public\.(\w+)/gi) || []).every((d) => /public\.perf_(research_|grade_|rg_)/.test(d)) && /drop table if exists public\.perf_research_grades/.test(RSQL));
T.chk('S standalone: it uses none of model_performance.sql\'s functions or tables', !/perf_append_only\(|perf_stamp\(|perf_ingest_runs|perf_ingest\(/.test(SQL));

(async function main() {
  const db = PG.start('rgsql');
  if (db.skip) {
    if (process.env.PERF_SQL_REQUIRED === '1') T.chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
    console.log('NOTE | ' + db.skip + ' — the live layer did not run');
    process.exit(T.done());
  }
  const ok = (out) => !/CHECK THIS/.test(out) && /\bok\b/.test(out);
  const one = (s) => String(s).trim();
  function ingest(kind, rows, as) {
    const q = 'select public.perf_research_ingest(' + lit(kind) + ', ' + lit(JSON.stringify(rows)) + '::jsonb, ' + lit('test') + ', null);';
    return JSON.parse((as || db.service)(q));
  }
  const fx = await F.lifecycle();
  try {
    /* APPLY, beside the model performance mirror */
    let out = db.applyFileAtomic(PERF);
    T.chk('A model_performance.sql applies first (they live side by side)', ok(out), out.slice(0, 300));
    out = db.applyFileAtomic(FILE);
    T.chk('A the contract applies (as one transaction) and its report is all ok', ok(out), out.slice(0, 600));
    out = db.applyFile(FILE);
    T.chk('A …and applies again (idempotent)', ok(out), out.slice(0, 600));

    /* INGEST rows the job wrote */
    const gRows = SYNC.pending(fx.root, 'research_grades', {});
    const oRows = SYNC.pending(fx.root, 'grade_outcomes', {});
    T.chk('I the lifecycle wrote grades and an outcome to mirror', gRows.length === 2 && oRows.length === 1, [gRows.length, oRows.length]);
    T.chk('I an outcome before its grade is refused (it names no stored grade)', /no stored research grade/.test(db.mustFail(() => ingest('grade_outcomes', oRows)) || ''));
    let r = ingest('research_grades', gRows);
    T.chk('I grades ingest', r.received === 2 && r.inserted === 2, r);
    r = ingest('grade_outcomes', oRows);
    T.chk('I the outcome ingests once its grade is stored', r.inserted === 1, r);
    r = ingest('research_grades', gRows);
    T.chk('I the same rows again add nothing (a duplicate job run)', r.inserted === 0 && r.already_present === 2, r);
    T.chk('I every ingest is logged, server-side', one(db.sql('select count(*) from public.perf_rg_ingest_runs;')) === '3');
    const heads = JSON.parse(db.service('select public.perf_research_heads();'));
    T.chk('I the heads say where each file stands, so a sync sends only what is new', heads['research_grades|performance/ledger/research_grades/nfl-2026.jsonl'] === 2 && SYNC.pending(fx.root, 'research_grades', heads).length === 0, heads);
    T.chk('I the columns are lifted from the row (letter, score, versions, market, model)', one(db.sql("select letter || '|' || score || '|' || grade_version || '|' || market_status || '|' || model_id from public.perf_research_grades where revision = 2;"))
      === [gRows[1].row.grade.letter, gRows[1].row.grade.score, 'rg_v1', 'CAPTURED', 'edgedesk_football_v1.0.0'].join('|'));
    T.chk('I the outcome keeps its Brier, errors and pregame-side records', one(db.sql("select brier || '|' || margin_abs_error || '|' || ats_result || '|' || ou_result from public.perf_grade_outcomes;")) === '0.16|0.5|win|loss');

    /* refusals */
    const base = JSON.parse(JSON.stringify(gRows[0]));
    const forged = Object.assign({}, gRows[1], { hash: 'f'.repeat(64), seq: 3, prev: 'e'.repeat(64) });
    T.chk('I a row that does not follow the stored chain is refused', /does not follow the stored chain/.test(db.mustFail(() => ingest('research_grades', [forged])) || ''));
    const g1 = Object.assign({}, base, { hash: 'a'.repeat(64), ledger_file: 'performance/ledger/research_grades/x-2099.jsonl', prev: 'b'.repeat(64) });
    T.chk('I a chain must start at GENESIS', /must start the chain/.test(db.mustFail(() => ingest('research_grades', [g1])) || ''));
    const late = Object.assign({}, base, { hash: 'c'.repeat(64), ledger_file: 'performance/ledger/research_grades/late-2099.jsonl', seq: 1, prev: 'GENESIS' });
    late.row = Object.assign({}, base.row, { captured_at: base.start_utc });
    T.chk('I a grade captured at the start is refused', /perf_research_grades_pregame/.test(db.mustFail(() => ingest('research_grades', [late])) || ''));
    const wrong = Object.assign({}, base, { hash: 'd'.repeat(64), ledger_file: 'performance/ledger/research_grades/wrong-2099.jsonl', seq: 1, prev: 'GENESIS' });
    wrong.row = JSON.parse(JSON.stringify(base.row)); wrong.row.grade.letter = 'A'; wrong.row.grade.score = 71;
    T.chk('I a letter that is not its score\'s (A at 71) is refused', /perf_research_grades_letter/.test(db.mustFail(() => ingest('research_grades', [wrong])) || ''));
    const ins = Object.assign({}, base, { hash: '1'.repeat(64), ledger_file: 'performance/ledger/research_grades/ins-2099.jsonl', seq: 1, prev: 'GENESIS' });
    ins.row = JSON.parse(JSON.stringify(base.row)); ins.row.grade.state = 'INSUFFICIENT'; ins.row.grade.letter = null; ins.row.grade.score = null;
    T.chk('I an INSUFFICIENT grade carries no letter and no score, and is stored', ingest('research_grades', [ins]).inserted === 1);
    const ins2 = Object.assign({}, ins, { hash: '2'.repeat(64), ledger_file: 'performance/ledger/research_grades/ins2-2099.jsonl' });
    ins2.row = JSON.parse(JSON.stringify(ins.row)); ins2.row.grade.letter = 'C';
    T.chk('I …an INSUFFICIENT grade with a letter is refused', /perf_research_grades_letter/.test(db.mustFail(() => ingest('research_grades', [ins2])) || ''));
    /* an outcome that judges a grade made after the start: store a grade for a later start, then an outcome with an earlier start */
    const ob = JSON.parse(JSON.stringify(oRows[0]));
    const after = Object.assign({}, ob, { hash: '3'.repeat(64), ledger_file: 'performance/ledger/grade_outcomes/after-2099.jsonl', seq: 1, prev: 'GENESIS', start_utc: '2026-10-01T12:00:00Z' });
    after.row = Object.assign({}, ob.row, { start_utc: '2026-10-01T12:00:00Z', snapshot_hash: gRows[1].hash });
    T.chk('I an outcome judging a grade captured after the game started is refused (no backfill)', /captured at or after the start/.test(db.mustFail(() => ingest('grade_outcomes', [after])) || ''));
    const relabel = Object.assign({}, ob, { hash: '4'.repeat(64), ledger_file: 'performance/ledger/grade_outcomes/relabel-2099.jsonl', seq: 1, prev: 'GENESIS' });
    relabel.row = Object.assign({}, ob.row, { letter: 'A' });
    T.chk('I an outcome that relabels its grade\'s letter is refused', /differs from the grade/.test(db.mustFail(() => ingest('grade_outcomes', [relabel])) || ''));
    const stampOk = one(db.sql('select bool_and(abs(extract(epoch from (server_recorded_at - now()))) < 600) from public.perf_research_grades;'));
    T.chk('I server_recorded_at is the server clock', stampOk === 't');
    const direct = db.mustFail(() => db.service("insert into public.perf_research_grades (hash, ledger_file, seq, prev, event_key, sport, start_utc, captured_at, grade_version, grade_state, revision, row) values ("
      + lit('5'.repeat(64)) + ", 'x', 1, 'GENESIS', 'X|1', 'nfl', '2099-01-01', '2098-01-01', 'rg_v1', 'INSUFFICIENT', 1, '{}');"));
    T.chk('I the service role cannot write around perf_research_ingest (no direct INSERT)', /permission denied/.test(direct || ''), direct);

    /* APPEND-ONLY, for every role */
    ['perf_research_grades', 'perf_grade_outcomes', 'perf_rg_ingest_runs'].forEach((t) => {
      T.chk('P ' + t + ': the service role cannot UPDATE', !!db.mustFail(() => db.service('update public.' + t + ' set ' + (t === 'perf_rg_ingest_runs' ? 'kind' : 'event_key') + " = 'x';")));
      T.chk('P ' + t + ': the service role cannot DELETE', !!db.mustFail(() => db.service('delete from public.' + t + ';')));
      T.chk('P ' + t + ': even the owner cannot DELETE', /append-only/.test(db.mustFail(() => db.sql('delete from public.' + t + ';')) || ''));
      T.chk('P ' + t + ': even the owner cannot TRUNCATE', /append-only/.test(db.mustFail(() => db.sql('truncate public.' + t + ' cascade;')) || ''));
    });

    /* READ: a future game's grade is stored but hidden until it starts */
    const fut = Object.assign({}, base, { hash: '6'.repeat(64), ledger_file: 'performance/ledger/research_grades/future-2099.jsonl', seq: 1, prev: 'GENESIS', start_utc: '2099-01-01T00:00:00Z', event_key: 'NFL|FUTURE' });
    fut.row = Object.assign({}, base.row, { captured_at: '2026-10-16T00:00:00Z', start_utc: '2099-01-01T00:00:00Z' });
    T.chk('R a future game\'s pregame grade is stored', ingest('research_grades', [fut]).inserted === 1);
    T.chk('R anon cannot see it before the game', one(db.anon("select count(*) from public.perf_research_grades where event_key = 'NFL|FUTURE';")) === '0');
    T.chk('R a signed-in reader cannot either', one(db.as('00000000-0000-0000-0000-000000000001', "select count(*) from public.perf_research_grades where event_key = 'NFL|FUTURE';")) === '0');
    T.chk('R anon reads the grades of started games and every outcome', one(db.anon('select count(*) from public.perf_research_grades;')) === '3' && one(db.anon('select count(*) from public.perf_grade_outcomes;')) === '1');
    T.chk('R anon cannot read the ingest log', !!db.mustFail(() => db.anon('select count(*) from public.perf_rg_ingest_runs;')));
    T.chk('W anon cannot call perf_research_ingest', /permission denied/.test(db.mustFail(() => ingest('research_grades', gRows.slice(0, 1), db.anon)) || ''));
    T.chk('W a signed-in reader cannot call perf_research_ingest', /permission denied/.test(db.mustFail(() => ingest('research_grades', gRows.slice(0, 1), (q) => db.as('00000000-0000-0000-0000-000000000001', q))) || ''));
    T.chk('W anon cannot call perf_research_heads', /permission denied/.test(db.mustFail(() => db.anon('select public.perf_research_heads();')) || ''));
    T.chk('W anon cannot insert an outcome directly', !!db.mustFail(() => db.anon("insert into public.perf_grade_outcomes (hash) values (" + lit('7'.repeat(64)) + ");")));

    /* AGG: the view equals the kernel on the same rows */
    const st = require('./run.js').loadState(fx.root);
    const rows = GB.publicRows(st, Date.parse('2026-10-03T00:00:00Z')).rows;
    const k = G.performance(rows).by_letter;
    const letter = rows[0].letter;
    const v = db.anon("select games || '|' || settled || '|' || coalesce(brier::text, 'null') || '|' || brier_n || '|' || ats_w || '|' || ou_l from public.perf_grade_performance where sport = 'all' and letter = " + lit(letter) + ';');
    T.chk('G the aggregate view answers anon and equals the kernel (games, settled, Brier below 20 → null, records)', one(v) === [k[letter].games, k[letter].settled, 'null', 1, 1, 1].join('|'), { view: one(v), kernel: { games: k[letter].games, settled: k[letter].settled } });
    T.chk('G the latest-outcome view keeps one row per game', one(db.anon('select count(*) from public.perf_grade_outcomes_latest;')) === '1');

    /* ROLLBACK, each side alone */
    out = db.applyFile(PERF_RB);
    T.chk('B rolling back model_performance.sql leaves the research grade mirror whole', ok(out) && one(db.sql('select count(*) from public.perf_research_grades;')) === '4');
    out = db.applyFile(RB);
    T.chk('B the rollback removes exactly its objects', ok(out) && one(db.sql("select count(*) from pg_class where relname ~ '^perf_(research_|grade_|rg_)';")) === '0', out);
    out = db.applyFile(FILE);
    T.chk('B the contract applies again after a rollback', ok(out), out.slice(0, 400));
  } catch (e) {
    T.chk('the run completed', false, String(e.message).slice(0, 900));
  } finally { db.stop(); fs.rmSync(fx.root, { recursive: true, force: true }); }
  process.exit(T.done());
})();
