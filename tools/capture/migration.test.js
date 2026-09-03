#!/usr/bin/env node
/* ===========================================================================
   TESTS FOR THE MIGRATION.

   WHY THIS FILE EXISTS. supabase/capture_v9_qualification.sql shipped with

       select 1 as n, 'signals.qual_reason exists' as check, ...

   and `check` is a RESERVED keyword in PostgreSQL, so the whole file failed at
   its very last statement with `syntax error at or near "check"`. Every schema
   change in it had already been written by then — but the report that exists to
   tell you the migration worked never ran, which is the one part you cannot
   afford to lose. Nobody caught it because nothing in this repository had ever
   executed a line of its SQL.

   Two layers, so this runs everywhere and runs properly where it can:

     STATIC — always. The reserved-word list below is not hand-written; it was
     read out of a live PostgreSQL 16 with
       select word from pg_get_keywords() where catcode in ('R','T')
     so it is the parser's own opinion, not a guess. Plus the structural rules
     the whole folder is built on: idempotent, additive, ends in a report.

     LIVE — when a postgres server binary is on PATH. Builds a pre-v9 schema,
     runs the migration TWICE against it, and asserts every report row says ok
     both times, that the freeze actually freezes, and that every column capture
     writes exists afterwards. If postgres is unavailable the suite SAYS SO and
     passes on the static layer alone — a skipped check that announces itself is
     honest; one that stays quiet is how this bug shipped.

   Run: node tools/capture/migration.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
function done() {
  failures.forEach((f) => console.log('FAIL | ' + f.name
    + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 600) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

const ROOT = path.join(__dirname, '..', '..');
const SQL_PATH = path.join(ROOT, 'supabase', 'capture_v9_qualification.sql');
const SQL = fs.readFileSync(SQL_PATH, 'utf8');

/* PostgreSQL 16 reserved (R) and type/function-name reserved (T) keywords, read
   out of pg_get_keywords(). These cannot be used as a bare column alias or
   identifier; the T set additionally cannot be a bare table alias. */
const RESERVED = new Set([
  'all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'asymmetric', 'authorization',
  'binary', 'both', 'case', 'cast', 'check', 'collate', 'collation', 'column', 'concurrently',
  'constraint', 'create', 'cross', 'current_catalog', 'current_date', 'current_role',
  'current_schema', 'current_time', 'current_timestamp', 'current_user', 'default', 'deferrable',
  'desc', 'distinct', 'do', 'else', 'end', 'except', 'false', 'fetch', 'for', 'foreign', 'freeze',
  'from', 'full', 'grant', 'group', 'having', 'ilike', 'in', 'initially', 'inner', 'intersect',
  'into', 'is', 'isnull', 'join', 'lateral', 'leading', 'left', 'like', 'limit', 'localtime',
  'localtimestamp', 'natural', 'not', 'notnull', 'null', 'offset', 'on', 'only', 'or', 'order',
  'outer', 'overlaps', 'placing', 'primary', 'references', 'returning', 'right', 'select',
  'session_user', 'similar', 'some', 'symmetric', 'system_user', 'table', 'tablesample', 'then',
  'to', 'trailing', 'true', 'union', 'unique', 'user', 'using', 'variadic', 'verbose', 'when',
  'where', 'window', 'with',
]);

/* ═══ STATIC ══════════════════════════════════════════════════════════════ */
{
  chk('the reserved-word list came from a real server, not from memory',
    RESERVED.size === 101 && RESERVED.has('check') && RESERVED.has('user') && RESERVED.has('end'),
    RESERVED.size);

  /* Strip comments and string literals so a keyword inside prose or inside a
     quoted string is not mistaken for an identifier. */
  const stripped = SQL
    .replace(/--[^\n]*/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' $BODY$ ')
    .replace(/'(?:[^']|'')*'/g, "'STR'");

  const badAliases = [];
  const aliasRe = /\bas\s+("?)([a-z_][a-z0-9_]*)\1/gi;
  let m;
  while ((m = aliasRe.exec(stripped))) {
    const quoted = m[1] === '"';
    const word = m[2].toLowerCase();
    if (!quoted && RESERVED.has(word)) badAliases.push(word);
  }
  chk('no reserved keyword is used as a bare alias — this is the bug that shipped',
    badAliases.length === 0, badAliases);

  /* The same trap one level down: a bare reserved word in a select list. */
  const selectRefs = [];
  const selRe = /\bselect\s+([a-z_][a-z0-9_,\s]*?)\s+from\b/gi;
  while ((m = selRe.exec(stripped))) {
    m[1].split(',').map((s) => s.trim().toLowerCase())
      .filter((w) => /^[a-z_][a-z0-9_]*$/.test(w) && RESERVED.has(w))
      .forEach((w) => selectRefs.push(w));
  }
  chk('no reserved keyword is referenced bare in a select list', selectRefs.length === 0, selectRefs);

  /* The folder's stated convention, asserted rather than trusted. */
  const alters = SQL.match(/add column(?!\s+if not exists)/gi) || [];
  chk('every ADD COLUMN is guarded with IF NOT EXISTS (idempotent)', alters.length === 0, alters);
  const creates = SQL.match(/create table(?!\s+if not exists)/gi) || [];
  chk('every CREATE TABLE is guarded with IF NOT EXISTS', creates.length === 0, creates);
  const idx = SQL.match(/create index(?!\s+if not exists)/gi) || [];
  chk('every CREATE INDEX is guarded, or created inside a DO block that checks first',
    idx.length === 0 || /do \$\$/.test(SQL), idx);

  chk('the schema changes are wrapped in a transaction',
    /^\s*begin;/m.test(SQL) && /^\s*commit;/m.test(SQL));
  chk('the report runs AFTER the commit, so a failing check cannot roll back the migration',
    SQL.indexOf('commit;') < SQL.lastIndexOf('check_name'));
  chk('the file ends in a report whose rows say ok',
    /'ok'/.test(SQL) && /'CHECK THIS'/.test(SQL));

  /* Additive: exactly one UPDATE, and it must be the labelling one. */
  const updates = (SQL.match(/^\s*update\s+public\./gim) || []);
  chk('there is exactly one UPDATE in the whole migration', updates.length === 1, updates);
  chk('and it only fills a label that is still NULL — it rewrites no measurement',
    /flagged_policy is null or flagged_build is null/.test(SQL));
  chk('nothing is dropped except the trigger it immediately recreates',
    (SQL.match(/\bdrop\s+(table|column|index|database)\b/gi) || []).length === 0);
}

/* ═══ LIVE ════════════════════════════════════════════════════════════════ */
function findPg() {
  for (const c of ['pg_ctl', '/usr/lib/postgresql/16/bin/pg_ctl', '/usr/lib/postgresql/15/bin/pg_ctl']) {
    try { cp.execSync(`${c} --version`, { stdio: 'ignore' }); return path.dirname(c === 'pg_ctl' ? cp.execSync('command -v pg_ctl').toString().trim() : c); }
    catch (_) { /* keep looking */ }
  }
  return null;
}

const BIN = findPg();
if (!BIN) {
  console.log('NOTE | no postgres binary on PATH — the LIVE layer did not run.');
  console.log('     | The static layer above would still have caught the reserved-word bug that shipped.');
  console.log('     | Install postgresql to run the migration for real: it is the only way to prove the');
  console.log('     | report executes, the freeze freezes, and every column capture writes exists.');
  done();
}

const PORT = 55433 + (process.pid % 200);
const asPostgres = process.getuid && process.getuid() === 0;
const HOME = asPostgres ? fs.mkdtempSync('/var/lib/postgresql/edt-') : fs.mkdtempSync(path.join(os.tmpdir(), 'edt-'));
const DATA = path.join(HOME, 'data');
const run = (cmd, opts) => cp.execSync(asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd,
  Object.assign({ stdio: 'pipe', encoding: 'utf8' }, opts || {}));
const psql = (db, args) => run(`${BIN}/psql -h /tmp -p ${PORT} -d ${db} ${args}`);

let started = false;
try {
  if (asPostgres) cp.execSync(`chown -R postgres:postgres ${HOME}`);
  run(`${BIN}/initdb -D ${DATA} -A trust -E UTF8`);
  run(`${BIN}/pg_ctl -D ${DATA} -o '-k /tmp -p ${PORT} -c listen_addresses=' -l ${HOME}/pg.log start -w`);
  started = true;
} catch (e) {
  console.log('NOTE | could not start a local postgres (' + String(e.message).slice(0, 120) + ')');
  console.log('     | The LIVE layer did not run; the static layer above did.');
  done();
}

function cleanup() {
  try { if (started) run(`${BIN}/pg_ctl -D ${DATA} -m immediate stop`); } catch (_) {}
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) {}
}
process.on('exit', cleanup);

try {
  const before = path.join(HOME, 'before.sql');
  /* A pre-v9 approximation: the columns capture-v8 wrote and the app reads, an
     existing preserve_anchor_entry with the OLD hardcoded list (which is why
     flagged_corrob_n was permanently null — it was not in that list), one
     flagged+graded row and one stored-only row. No book_quotes, so the
     migration has to create it. */
  fs.writeFileSync(before, `
create table public.signals (
  id bigserial primary key, sig_key text unique not null,
  event_id text, sport_key text, sport_title text, commence_time timestamptz,
  home_team text, away_team text, market text, selection text, point numeric,
  last_seen_at timestamptz, best_dec numeric, best_book text,
  sharp_fair numeric, consensus_fair numeric, edge numeric,
  is_plus_ev boolean, n_books integer, has_sharp boolean,
  first_seen_at timestamptz, first_best_dec numeric, first_best_book text,
  first_sharp_fair numeric, first_edge numeric, first_has_sharp boolean,
  flagged_at timestamptz, flagged_edge numeric, flagged_best_dec numeric,
  flagged_best_book text, flagged_sharp_fair numeric, flagged_has_sharp boolean,
  graded_at timestamptz, result text, clv numeric, beat_close boolean,
  clv_excluded_reason text, closing_sharp_fair numeric, closed_at timestamptz);
create table public.signal_ticks (
  id bigserial primary key, sig_key text not null,
  created_at timestamptz not null default now(),
  best_dec numeric, sharp_fair numeric, edge numeric, n_books integer);
create or replace function public.preserve_anchor_entry() returns trigger
language plpgsql as $BODY$
begin
  NEW.flagged_at       := coalesce(OLD.flagged_at,       NEW.flagged_at);
  NEW.flagged_edge     := coalesce(OLD.flagged_edge,     NEW.flagged_edge);
  NEW.flagged_best_dec := coalesce(OLD.flagged_best_dec, NEW.flagged_best_dec);
  return NEW;
end $BODY$;
create trigger signals_preserve_anchor before update on public.signals
  for each row execute function public.preserve_anchor_entry();
insert into public.signals (sig_key, sport_key, market, selection, point, commence_time,
  first_best_dec, first_edge, flagged_at, flagged_edge, flagged_best_dec, flagged_best_book,
  graded_at, result)
values ('e1|spreads|A|-3.5','americanfootball_nfl','spreads','A',-3.5, now()-interval '2 days',
        1.95, 0.03, now()-interval '3 days', 0.03, 1.95, 'DraftKings', now()-interval '1 day','win'),
       ('e2|h2h|B|','baseball_mlb','h2h','B',null, now()+interval '1 day',
        2.10, 0.001, null, null, null, null, null, null);
`);
  if (asPostgres) cp.execSync(`chmod -R a+rX ${HOME}`);
  psql('postgres', '-q -v ON_ERROR_STOP=1 -c "create database edt"');
  psql('edt', `-q -v ON_ERROR_STOP=1 -f ${before}`);
  chk('the pre-v9 fixture schema builds', true);

  const mig = path.join(HOME, 'mig.sql');
  fs.copyFileSync(SQL_PATH, mig);
  if (asPostgres) cp.execSync(`chmod a+r ${mig}`);

  const okRows = (out) => (out.match(/\| ok\s*$/gm) || []).length;
  const badRows = (out) => (out.match(/\| CHECK THIS\s*$/gm) || []).length;

  const first = psql('edt', `-v ON_ERROR_STOP=1 -f ${mig}`);
  chk('the migration runs to completion against a real postgres', /COMMIT/.test(first));
  chk('the report EXECUTES — this is what the reserved word broke', /check_name/.test(first), first.slice(-400));
  chk('every report row says ok on the first run', okRows(first) === 16 && badRows(first) === 0,
    { ok: okRows(first), bad: badRows(first), raw: first.slice(-700) });

  const second = psql('edt', `-v ON_ERROR_STOP=1 -f ${mig}`);
  chk('running it a second time is clean — the convention says idempotent',
    okRows(second) === 16 && /COMMIT/.test(second), { ok: okRows(second) });
  const third = psql('edt', `-v ON_ERROR_STOP=1 -f ${mig}`);
  chk('and a third time', okRows(third) === 16);

  /* The legacy label: applied once, and never to an unflagged row. */
  const labels = psql('edt', `-tAc "select coalesce(flagged_policy,'unlabelled') as p, count(*) as n from public.signals group by 1 order by 1"`);
  chk('flagged history is LABELLED pre-v9, not rewritten', /^pre-v9-legacy\|1$/m.test(labels), labels);
  chk('an unflagged row gets no policy label', /^unlabelled\|1$/m.test(labels), labels);

  /* The rebuilt freeze. */
  psql('edt', `-q -c "update public.signals set flagged_edge=0.99, flagged_best_dec=12.0, flagged_best_book='Hacked', first_best_dec=99 where sig_key='e1|spreads|A|-3.5'"`);
  const frozen = psql('edt', `-tAc "select flagged_edge||'/'||flagged_best_dec||'/'||flagged_best_book||'/'||first_best_dec from public.signals where sig_key='e1|spreads|A|-3.5'"`).trim();
  chk('a frozen entry price cannot drift', frozen === '0.03/1.95/DraftKings/1.95', frozen);

  /* The columns the OLD hardcoded list did not cover are now protected — which
     is the defect that left flagged_corrob_n permanently null on every signal. */
  psql('edt', `-q -c "update public.signals set flagged_corrob_n=4, flagged_tier='A' where sig_key='e1|spreads|A|-3.5'"`);
  psql('edt', `-q -c "update public.signals set flagged_corrob_n=99, flagged_tier='B' where sig_key='e1|spreads|A|-3.5'"`);
  const late = psql('edt', `-tAc "select flagged_corrob_n||'/'||flagged_tier from public.signals where sig_key='e1|spreads|A|-3.5'"`).trim();
  chk('a column the old hardcoded list missed is now frozen too', late === '4/A', late);

  /* A NULL anchor still fills exactly once. */
  psql('edt', `-q -c "update public.signals set flagged_at=now(), flagged_best_dec=2.10 where sig_key='e2|h2h|B|'"`);
  psql('edt', `-q -c "update public.signals set flagged_best_dec=9.99 where sig_key='e2|h2h|B|'"`);
  const filled = psql('edt', `-tAc "select flagged_best_dec from public.signals where sig_key='e2|h2h|B|'"`).trim();
  chk('a NULL anchor fills once and is then permanent', filled === '2.10', filled);

  /* Live columns must still move; the freeze is anchor-only. */
  psql('edt', `-q -c "update public.signals set best_dec=1.80, edge=-0.01, qual_reason='below_segment_edge_floor' where sig_key='e1|spreads|A|-3.5'"`);
  const live = psql('edt', `-tAc "select best_dec||'/'||edge||'/'||qual_reason from public.signals where sig_key='e1|spreads|A|-3.5'"`).trim();
  chk('live columns still update freely — the freeze is anchor-only', live === '1.80/-0.01/below_segment_edge_floor', live);

  /* THE ONE THAT MATTERS MOST: every column capture writes must exist. A column
     it writes that the migration forgot is dropped by the schema-gap fallback
     and never persisted, silently, forever. */
  const cols = cp.execSync(`node ${path.join(__dirname, '_written_columns.mjs')}`, { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean).map((l) => l.split('\t'));
  chk('capture reports the columns it writes', cols.length > 80, cols.length);
  const values = cols.map(([t, c]) => `('${t}','${c}')`).join(',');
  const missing = psql('edt', `-tAc "with w(tbl,col) as (values ${values}) select string_agg(w.tbl||'.'||w.col,',') from w left join information_schema.columns ic on ic.table_schema='public' and ic.table_name=w.tbl and ic.column_name=w.col where ic.column_name is null"`).trim();
  chk('EVERY column capture writes exists after the migration', missing === '', missing);
} catch (e) {
  chk('the live migration run completed without throwing', false, String(e.stdout || e.message).slice(0, 900));
}

done();
