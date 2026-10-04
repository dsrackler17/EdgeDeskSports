#!/usr/bin/env node
/* ===========================================================================
   THE RECOMMENDATION LEDGER, AGAINST A REAL POSTGRESQL.

   Immutability is the only property that makes a performance claim mean
   anything, and it is enforced by a trigger — so it can only be proved by a
   server. The static layer below holds the conventions; the live layer starts
   a throwaway cluster, applies supabase/recommendation_ledger.sql and then
   tries to do the things the table exists to prevent.

   Run: node tools/intelligence/ledger_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'recommendation_ledger.sql'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function done(note) {
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 300) : '')));
  if (note) console.log(note);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* ═══ STATIC ═══════════════════════════════════════════════════════════════ */
chk('the migration is idempotent', /create table if not exists/.test(SQL) && /drop trigger if exists/.test(SQL));
chk('an immutability trigger exists', /recommendation_ledger_immutable_trg/.test(SQL));
chk('deletion is blocked', /recommendation_ledger_no_delete/.test(SQL));
chk('forward rows cannot postdate kickoff', /recommendation_ledger_no_lookahead/.test(SQL));
chk('backtests are a separate mode', /check \(mode in \('FORWARD','BACKTEST'\)\)/.test(SQL));
chk('the decision vocabulary is constrained',
  /check \(decision in \('BET CANDIDATE','WATCH','PASS','INSUFFICIENT DATA'\)\)/.test(SQL));
chk('row level security is on', /enable row level security/.test(SQL));
chk('the reporting view never sums forward and backtest', /group by r\.mode/.test(SQL));
chk('the view counts pushes into the stake but not the win rate',
  /amount_staked/.test(SQL) && /result in \('win','loss'\)\)/.test(SQL));
chk('the view flags an insufficient sample', /sufficient_sample/.test(SQL));
/* APPLYING IT IS NOT THE LAST STEP, AND THAT COST A RELEASE.
   A live run created the table, the indexes, the triggers, the policies and the
   view and committed cleanly — and the deployment doctor one second later still
   reported NOT_APPLIED, because PostgREST caches the schema in memory and had
   started before the table existed. Everything that touches this table goes
   through PostgREST, the edge function's insert included, so the migration
   looked perfect and the ledger stayed invisible to the only clients that use
   it. The reload has to be part of the migration, not folklore. */
chk('the migration tells PostgREST to reload its schema cache',
  /notify\s+pgrst\s*,\s*'reload schema'/i.test(SQL));
chk('and does so AFTER the transaction commits, so it fires on durable state',
  SQL.lastIndexOf('commit;') < SQL.toLowerCase().lastIndexOf("notify pgrst"));

chk('official corrections are an appended kind, not an edit',
  /check \(kind in \('RECOMMENDATION','UPDATE','CORRECTION'\)\)/.test(SQL));
chk('a correction must name its target, its reason and its source',
  /recommendation_ledger_correction_shape/.test(SQL));
chk('and must point at a row that exists', /recommendation_ledger_correction_trg/.test(SQL));
chk('the record view reads the corrected outcome', /coalesce\(x\.result, o\.result\)/.test(SQL));
chk('and still keeps what was originally published', /result_as_published/.test(SQL));

/* ═══ LIVE ═════════════════════════════════════════════════════════════════ */
function findPgBin() {
  const cands = ['pg_ctl'].concat(
    (() => { try { return fs.readdirSync('/usr/lib/postgresql').sort().reverse()
      .map((v) => '/usr/lib/postgresql/' + v + '/bin/pg_ctl'); } catch (_) { return []; } })());
  for (const c of cands) {
    try {
      cp.execSync(`${c} --version`, { stdio: 'ignore' });
      return c === 'pg_ctl' ? path.dirname(cp.execSync('command -v pg_ctl').toString().trim()) : path.dirname(c);
    } catch (_) { /* keep looking */ }
  }
  return null;
}
const BIN = findPgBin();
if (!BIN) {
  done('NOTE | no postgres binary on PATH — the LIVE layer did not run.\n'
     + '     | The static layer above holds the conventions; only a real server can hold\n'
     + '     | immutability. CI installs postgres.');
}

const PORT = 55900 + (process.pid % 200);
const asPostgres = process.getuid && process.getuid() === 0;
const HOME = asPostgres ? fs.mkdtempSync('/var/lib/postgresql/led-') : fs.mkdtempSync(path.join(os.tmpdir(), 'led-'));
const DATA = path.join(HOME, 'data');
const run = (cmd, opts) => cp.execSync(asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd,
  Object.assign({ stdio: 'pipe', encoding: 'utf8' }, opts || {}));

let started = false;
try {
  /* The directory is created by root; postgres has to be able to write into
     it, and the chown must therefore run AS ROOT rather than through the
     `su postgres` wrapper that everything else here uses. */
  if (asPostgres) cp.execSync(`chown -R postgres ${HOME} && chmod 700 ${HOME}`);
  run(`${BIN}/initdb -D ${DATA} -U postgres -A trust`);
  run(`${BIN}/pg_ctl -D ${DATA} -o "-p ${PORT} -k ${HOME} -c listen_addresses=" -l ${HOME}/log start -w -t 30`);
  started = true;
} catch (e) {
  done('NOTE | postgres would not start (' + String(e.message).slice(0, 120) + ') — LIVE layer skipped.');
}

/* Newlines are flattened before the statement reaches the shell: JSON.stringify
   turns a real newline into a literal backslash-n, and psql reads a backslash
   as the start of a meta-command. One statement, one line. */
const psql = (sql, opts) => run(
  `${BIN}/psql -h ${HOME} -p ${PORT} -U postgres -d postgres -v ON_ERROR_STOP=1 -t -A -c `
  + JSON.stringify(String(sql).replace(/\s+/g, ' ').trim()), opts).trim();
const psqlFile = (file) => run(`${BIN}/psql -h ${HOME} -p ${PORT} -U postgres -d postgres -v ON_ERROR_STOP=1 -f ${file}`);
/** Run something that MUST fail, and return the server's message. */
function mustFail(sql) {
  try { psql(sql); return null; } catch (e) { return String((e.stderr || e.stdout || e.message)); }
}

try {
  /* Supabase's auth.uid() does not exist in a bare cluster; the column default
     is the only thing that needs it, so a stub keeps the migration honest
     without changing what is being tested. */
  /* Dollar-quoted bodies go through a FILE, never through the shell: `$$` in a
     double-quoted argument is the shell's PID, which turns a function body into
     a syntax error several layers from where it was written. */
  const prep = path.join(HOME, 'prep.sql');
  fs.writeFileSync(prep, [
    'create schema if not exists auth;',
    "create or replace function auth.uid() returns uuid language sql stable as $fn$ select '00000000-0000-0000-0000-000000000001'::uuid $fn$;",
    "do $blk$ begin if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if; end $blk$;",
  ].join('\n'));
  const tmp = path.join(HOME, 'ledger.sql');
  fs.writeFileSync(tmp, SQL);
  if (asPostgres) cp.execSync(`chown postgres ${prep} ${tmp} && chmod 644 ${prep} ${tmp}`);
  psqlFile(prep);
  psqlFile(tmp);
  chk('the migration applies to a clean database', true);

  /* It must be safe to run again — that is what the header promises. */
  psqlFile(tmp);
  chk('and applies a second time without error', true);

  const KICK = "2026-09-20T19:00:00Z";
  const PUB = "2026-09-14T18:00:00Z";
  psql(`insert into public.recommendation_ledger
    (entry_key, sport, game_id, matchup, kickoff, market, selection, handicap,
     odds_decimal, odds_american, book, decision, strength, probability,
     expected_value, evidence_packet_id, model_version, mode, published_at)
    values ('k1','americanfootball_ncaaf','g1','North Texas @ Texas State','${KICK}',
     'spreads','North Texas',-2.5,1.9524,'-105','DraftKings','BET CANDIDATE','clear',
     0.532,0.0374,'g1:v1','edgedesk_cfb_p4_v1.0.0','FORWARD','${PUB}')`);
  chk('a recommendation can be published', psql("select decision from public.recommendation_ledger where entry_key='k1'") === 'BET CANDIDATE');

  /* ---- the whole point of the table ------------------------------------ */
  let err = mustFail("update public.recommendation_ledger set decision='PASS' where entry_key='k1'");
  chk('a published decision cannot be edited', !!err && /is immutable/.test(err), err && err.slice(0, 160));
  err = mustFail("update public.recommendation_ledger set odds_decimal=2.5 where entry_key='k1'");
  chk('nor can its price', !!err && /is immutable/.test(err));
  err = mustFail("update public.recommendation_ledger set published_at=now() where entry_key='k1'");
  chk('nor its publication time', !!err && /is immutable/.test(err));
  err = mustFail("delete from public.recommendation_ledger where entry_key='k1'");
  chk('and it cannot be deleted', !!err && /never deleted/.test(err), err && err.slice(0, 160));
  chk('the original decision survives every attempt',
    psql("select decision||'|'||odds_american from public.recommendation_ledger where entry_key='k1'") === 'BET CANDIDATE|-105');

  /* ---- a change is a new row ------------------------------------------- */
  psql(`insert into public.recommendation_ledger
    (entry_key, supersedes, kind, sport, game_id, market, selection, decision, mode, reason, published_at, kickoff)
    values ('k1|u1','k1','UPDATE','americanfootball_ncaaf','g1','spreads','North Texas','PASS','FORWARD',
     'the price moved to -125','2026-09-15T10:00:00Z','${KICK}')`);
  chk('a later change is recorded as a separate row',
    psql("select count(*) from public.recommendation_ledger where game_id='g1'") === '2');
  chk('pointing back at the original',
    psql("select supersedes from public.recommendation_ledger where entry_key='k1|u1'") === 'k1');
  chk('and the original still says what it said at the time',
    psql("select decision from public.recommendation_ledger where entry_key='k1'") === 'BET CANDIDATE');

  /* ---- grading is write-once ------------------------------------------- */
  psql("update public.recommendation_ledger set result='win', clv=0.012, beat_close=true, graded_at=now() where entry_key='k1'");
  chk('a result can be graded in once', psql("select result from public.recommendation_ledger where entry_key='k1'") === 'win');
  err = mustFail("update public.recommendation_ledger set result='loss' where entry_key='k1'");
  chk('and a graded outcome is never rewritten', !!err && /is not rewritten/.test(err), err && err.slice(0, 160));

  /* ---- look-ahead --------------------------------------------------------- */
  err = mustFail(`insert into public.recommendation_ledger
    (entry_key, game_id, market, selection, decision, mode, kickoff, published_at, odds_decimal)
    values ('leak','g2','spreads','X','BET CANDIDATE','FORWARD','${KICK}','2026-09-21T00:00:00Z',1.9)`);
  chk('a forward row published after kickoff is refused by the database',
    !!err && /no_lookahead/.test(err), err && err.slice(0, 160));
  psql(`insert into public.recommendation_ledger
    (entry_key, game_id, market, selection, decision, mode, kickoff, published_at, odds_decimal, result)
    values ('bt1','g2','spreads','X','BET CANDIDATE','BACKTEST','${KICK}','2026-09-21T00:00:00Z',1.9,'win')`);
  chk('a backtest may be dated after the event, because it is not a recommendation', true);

  /* ---- the vocabulary ---------------------------------------------------- */
  err = mustFail(`insert into public.recommendation_ledger
    (entry_key, game_id, market, selection, decision, mode, odds_decimal)
    values ('bad','g3','spreads','X','STRONG BUY','FORWARD',1.9)`);
  chk('an invented decision word is refused', !!err && /decision_check|violates check/.test(err), err && err.slice(0, 120));

  /* ---- measurement -------------------------------------------------------- */
  psql(`insert into public.recommendation_ledger
    (entry_key, sport, game_id, market, selection, decision, mode, kickoff, published_at, odds_decimal, result, probability)
    values
    ('m2','americanfootball_ncaaf','g4','spreads','A','BET CANDIDATE','FORWARD','${KICK}','${PUB}',1.9524,'loss',0.52),
    ('m3','americanfootball_ncaaf','g5','spreads','B','BET CANDIDATE','FORWARD','${KICK}','${PUB}',1.9524,'push',null),
    ('m4','americanfootball_ncaaf','g6','spreads','C','BET CANDIDATE','FORWARD','${KICK}','${PUB}',1.9524,'void',null)`);
  const rec = psql(`select wins||'|'||losses||'|'||pushes||'|'||voids||'|'||n_decided||'|'||win_rate||'|'||amount_staked||'|'||sufficient_sample
    from public.recommendation_record where mode='FORWARD' and market='spreads' and decision='BET CANDIDATE'`);
  const [w, l, p, v, dec, wr, staked, suff] = rec.split('|');
  chk('the record counts wins, losses, pushes and voids separately', w === '1' && l === '1' && p === '1' && v === '1', rec);
  chk('a push is excluded from the win-rate denominator', dec === '2' && String(wr).indexOf('0.50') === 0, { dec, wr });
  chk('a pushed stake is still counted as staked', staked === '3', staked);
  chk('a void is not counted as staked', staked === '3', staked);
  chk('a small sample is flagged as insufficient', suff === 'false' || suff === 'f', suff);
  /* ---- OFFICIAL CORRECTIONS ------------------------------------------------
     A graded outcome is never rewritten, and official results still change. A
     correction is an appended row; both facts stay in the table. */
  err = mustFail("update public.recommendation_ledger set result='win' where entry_key='m2'");
  chk('a recorded outcome cannot be rewritten in place',
    !!err && /already carries result/.test(err), err && err.slice(0, 160));

  err = mustFail(`insert into public.recommendation_ledger
    (entry_key, kind, supersedes, game_id, market, selection, decision, mode, odds_decimal, result, correction_reason, correction_source)
    values ('c-orphan','CORRECTION','no-such-row','g4','spreads','A','BET CANDIDATE','FORWARD',1.9524,'win','x','y')`);
  chk('a correction naming a row that does not exist is refused',
    !!err && /corrects nothing|correction/.test(err), err && err.slice(0, 200));

  err = mustFail(`insert into public.recommendation_ledger
    (entry_key, kind, supersedes, game_id, market, selection, decision, mode, odds_decimal, result)
    values ('c-bare','CORRECTION','m2','g4','spreads','A','BET CANDIDATE','FORWARD',1.9524,'win')`);
  chk('a correction with no stated reason or source is refused',
    !!err && /correction_shape|violates check/.test(err), err && err.slice(0, 200));

  psql(`insert into public.recommendation_ledger
    (entry_key, kind, supersedes, sport, game_id, market, selection, decision, mode, odds_decimal, result, correction_reason, correction_source)
    values ('c1','CORRECTION','m2','americanfootball_ncaaf','g4','spreads','A','BET CANDIDATE','FORWARD',1.9524,'win',
            'the conference reversed a scoring decision on review and the final margin changed sides',
            'official conference statement 2026-09-15')`);
  const orig = psql("select coalesce(result,'null') from public.recommendation_ledger where entry_key='m2'");
  chk('the ORIGINAL row still says exactly what it said when published', orig === 'loss', orig);
  const rec2 = psql(`select wins||'|'||losses||'|'||n_corrected
    from public.recommendation_record where mode='FORWARD' and market='spreads' and decision='BET CANDIDATE'`);
  chk('the record reads the corrected outcome', rec2.split('|')[0] === '2' && rec2.split('|')[1] === '0', rec2);
  chk('and counts the correction rather than absorbing it', rec2.split('|')[2] === '1', rec2);

  psql(`insert into public.recommendation_ledger
    (entry_key, kind, supersedes, sport, game_id, market, selection, decision, mode, odds_decimal, result, correction_reason, correction_source, corrected_at)
    values ('c2','CORRECTION','m2','americanfootball_ncaaf','g4','spreads','A','BET CANDIDATE','FORWARD',1.9524,'void',
            'the game was subsequently ruled a no contest', 'official conference statement 2026-09-16', now() + interval '1 hour')`);
  const rec3 = psql(`select wins||'|'||voids from public.recommendation_record
    where mode='FORWARD' and market='spreads' and decision='BET CANDIDATE'`);
  chk('a second correction supersedes the first, and the first is still on file',
    rec3 === '1|2' && psql("select count(*) from public.recommendation_ledger where supersedes='m2'") === '2', rec3);

  const modes = psql("select string_agg(distinct mode, ',' order by mode) from public.recommendation_record");
  chk('backtests appear as their own population, never merged', modes === 'BACKTEST,FORWARD', modes);
  const btWins = psql("select wins from public.recommendation_record where mode='BACKTEST'");
  chk('and the backtest win is not in the forward record', btWins === '1' && w === '1', { btWins, w });
} catch (e) {
  chk('the live layer ran without an unexpected error', false, String(e.stderr || e.message).slice(0, 400));
} finally {
  if (started) { try { run(`${BIN}/pg_ctl -D ${DATA} -m immediate stop`); } catch (_) { /* going away anyway */ } }
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) { /* ditto */ }
}
done();
