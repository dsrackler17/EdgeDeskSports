#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk — supabase/wta_board.sql, run against a real PostgreSQL.

   WHAT THIS EXISTS TO CATCH. app.html has read wta.daily_research,
   wta.watchlist and wta.meta since the Tennis panel shipped, and no file in
   this repository has ever created them — `git log --all --name-only` matches
   no path containing "wta" at any point in the history. The schema is exposed
   to PostgREST, so it answered every read with "the relation is not there",
   which the panel reported honestly as

       The wta schema answers and is empty — zero rows.

   The contract is now three VIEWS over the tennis record rather than a second
   pipeline. That makes one new failure possible: the views and the page can
   disagree about column names, and a PostgREST select of a column that does
   not exist is a 400 the panel would report as a database fault.

   So this suite does not check a list of columns someone typed here. It reads
   the field names OUT OF app.html — every `r.<field>` inside the WTA module
   and every `p.<field>` in the watchlist renderer — and requires each one to
   be a real column of the view. A rename on either side fails this.

   It then seeds one WTA match end to end (players, rankings, ratings, a live
   fixture, a registered model and a prediction) and checks the arithmetic of
   every component against hand-computed values, because a view that returns
   the right COLUMNS full of wrong NUMBERS is the worse failure.

   Run: node tools/tennis/wta_board_sql.test.js
        EDGD_PG="-h 127.0.0.1 -p 5432 -U postgres" node tools/tennis/wta_board_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SHIM = path.join(ROOT, 'tools', 'games', 'sql', 'supabase_shim.sql');
const BILLING = path.join(ROOT, 'supabase', 'billing.sql');
const LIVE = path.join(ROOT, 'supabase', 'tennis_live_center.sql');
const RECORD = path.join(ROOT, 'supabase', 'tennis_record.sql');
const WTA = path.join(ROOT, 'supabase', 'wta_board.sql');
const APP = path.join(ROOT, 'app.html');
const DB = 'edgedesk_wta_board_sqltest';

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push(name + (detail !== undefined ? ' — ' + String(detail).slice(0, 200) : '')); }
const eq = (name, got, want) => chk(name, String(got) === String(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
/* numbers come back as text from psql -tA; compare to 2dp */
const near = (name, got, want) => chk(name, Math.abs(parseFloat(got) - want) < 0.05, `got ${got}, want ${want}`);

const have = (b) => cp.spawnSync('sh', ['-c', 'command -v ' + b], { encoding: 'utf8' }).status === 0;
const psql = (conn, args, o) => cp.spawnSync('psql', conn.concat(args), Object.assign({ encoding: 'utf8' }, o || {}));

function candidates() {
  const out = [];
  if (process.env.EDGD_PG) out.push(process.env.EDGD_PG.split(' '));
  if (process.env.PGHOST) out.push([]);
  out.push(['-h', '/var/tmp/edgpg/sock', '-p', '5433', '-U', 'postgres']);
  out.push(['-h', '127.0.0.1', '-p', '5432', '-U', 'postgres']);
  out.push([]);
  return out;
}
function skip(why) {
  console.log('SKIP | wta board SQL | ' + why);
  console.log('       (this suite needs PostgreSQL; CI runs it in games-sql.yml)');
  process.exit(0);
}
if (!have('psql')) skip('psql is not installed');
let conn = null;
for (const c of candidates()) { if (psql(c, ['-d', 'postgres', '-tAc', 'select 1']).status === 0) { conn = c; break; } }
if (!conn) skip('no reachable PostgreSQL server');

function drop() { psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DB + ' (force)']); }
drop();
if (psql(conn, ['-d', 'postgres', '-q', '-c', 'create database ' + DB]).status !== 0) skip('could not create the test database');
process.on('exit', drop);

const q = (sql) => (psql(conn, ['-d', DB, '-tAX', '-c', sql]).stdout || '').trim();
const run = (sql) => psql(conn, ['-d', DB, '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql]);

/* ---- 1. it applies, on top of the contracts it depends on --------------- */
for (const f of [SHIM, BILLING, LIVE, RECORD]) {
  if (psql(conn, ['-d', DB, '-q', '-v', 'ON_ERROR_STOP=1', '-f', f]).status !== 0) {
    skip('could not apply ' + path.basename(f));
  }
}
const applied = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-f', WTA]);
chk('supabase/wta_board.sql applies', applied.status === 0, String(applied.stderr || '').slice(0, 300));
chk('and its own report says ok on every relation',
  !/MISSING/.test(applied.stdout || ''), (applied.stdout || '').slice(0, 300));

/* IDEMPOTENT: it is a contract file, so running it twice must be safe. */
chk('it is idempotent', psql(conn, ['-d', DB, '-q', '-v', 'ON_ERROR_STOP=1', '-f', WTA]).status === 0);

/* THE RECORD CONTRACT MUST STILL BE INTACT. These are views over it. */
chk('the record contract still answers after wta is applied',
  q("select count(*) from tennis.board_current") === '0');

/* ---- 1b. A HAND-MADE wta SCHEMA, WHICH IS WHAT PRODUCTION ACTUALLY HAD ---
   The repository never created these relations, but the live database held
   them as TABLES, made by hand in the dashboard before this file existed.
   `create or replace view` over a table does not replace it, it fails with
   ERROR 42809, which is exactly where the first production run stopped —
   with wta.meta holding 14 rows of somebody's data.

   Those rows must survive. The contract renames a pre-existing table aside
   rather than dropping it, so a wrong call is reversible with a rename. */
{
  run(`drop schema if exists wta cascade;
       create schema wta;
       create table wta.meta (key text primary key, value text);
       insert into wta.meta select 'stamp_'||g, 'v'||g from generate_series(1,14) g;
       create table wta.daily_research (slate_date date, fav_id text);
       create table wta.watchlist (player_id text);`);
  const rescue = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-f', WTA]);
  chk('the contract applies over a hand-made wta schema of TABLES',
    rescue.status === 0, String(rescue.stderr || '').slice(0, 200));
  eq('and the 14 rows that were there are PRESERVED, not dropped',
    q('select count(*) from wta.meta_legacy'), '14');
  eq('meta is a view now', q(`select relkind::text from pg_class c join pg_namespace n
       on n.oid=c.relnamespace where n.nspname='wta' and c.relname='meta'`), 'v');
  eq('and so are the other two',
    q(`select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='wta' and c.relkind='v'
          and c.relname in ('daily_research','watchlist')`), '2');
  /* A SECOND RUN MUST NOT RESCUE AGAIN. It now finds views, not tables, so
     nothing is renamed and meta_legacy is not overwritten by an empty one. */
  const again = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-f', WTA]);
  chk('a second run is idempotent over the rescued schema', again.status === 0);
  chk('and does not rescue anything a second time',
    !/has been preserved/.test(String(again.stdout || '') + String(again.stderr || '')));
  eq('so the preserved rows are still there after re-running',
    q('select count(*) from wta.meta_legacy'), '14');
  run('drop table if exists wta.meta_legacy, wta.daily_research_legacy, wta.watchlist_legacy;');
}

/* ---- 2. the page's own field list, read out of app.html ----------------- */
const app = fs.readFileSync(APP, 'utf8');
const wtaStart = app.indexOf('async function sbGetWta(');
const wtaEnd = app.indexOf('function tddRenderOverview(');
chk('the WTA module is found in app.html', wtaStart >= 0 && wtaEnd > wtaStart);
const mod = app.slice(wtaStart, wtaEnd);

const colsOf = (rel) => new Set(q(
  `select column_name from information_schema.columns where table_schema='wta' and table_name='${rel}'`
).split('\n').map((s) => s.trim()).filter(Boolean));

const research = colsOf('daily_research');
const watch = colsOf('watchlist');

/* Fields the module reads off a research row. `r` is the research row
   everywhere in this module; anything it dereferences must be a column. */
const rFields = [...new Set((mod.match(/\br\.[a-z_]+/g) || []).map((s) => s.slice(2)))];
chk('app.html dereferences research fields at all', rFields.length >= 15, rFields.length);
const missingR = rFields.filter((f) => !research.has(f));
chk('EVERY field app.html reads off a research row is a column of wta.daily_research',
  missingR.length === 0, 'missing: ' + missingR.join(', '));

const pFields = [...new Set((mod.match(/\bp\.[a-z_]+/g) || []).map((s) => s.slice(2)))];
chk('app.html dereferences watchlist fields at all', pFields.length >= 6, pFields.length);
const missingP = pFields.filter((f) => !watch.has(f));
chk('EVERY field app.html reads off a watchlist row is a column of wta.watchlist',
  missingP.length === 0, 'missing: ' + missingP.join(', '));

/* The page ORDERS BY these, server-side, so a missing one is a 400 rather
   than a cosmetic difference. */
for (const c of ['slate_date', 'research_score']) {
  chk('daily_research can be ordered by ' + c, research.has(c));
}
for (const c of ['beat_close_rate', 'clv_avg', 'reliability', 'rank']) {
  chk('watchlist can be ordered by ' + c, watch.has(c));
}
chk('wta.meta answers the key/value shape the page reads',
  q("select count(*) from information_schema.columns where table_schema='wta' and table_name='meta' and column_name in ('key','value')") === '2');

/* ---- 3. one match, end to end, with arithmetic that can be checked ------ */
const seed = run(`
insert into tennis.players (player_id,source_player_id,tour,full_name,name_norm,source_key) values
  ('wta:100','sp100','WTA','Fav Player','fav player','archive'),
  ('wta:200','sp200','WTA','Dog Player','dog player','archive');
insert into tennis.tournaments (tournament_id,provider_tournament_id,tour,provider,name,start_date,surface,level,indoor)
  values ('wta:tq1','ptq1','WTA','test','Test Open','2026-09-20','hard','WTA1000',false);
insert into tennis.rankings_current (player_id,tour,rank,points,as_of,source_key) values
  ('wta:100','WTA',1,9100,'2026-09-15','archive'), ('wta:200','WTA',87,940,'2026-09-15','archive');
insert into tennis.player_ratings_current
  (player_id,tour,rating_version,power_rating,uncertainty,official_rank,form_90d,rest_days,matches_14d,computed_at,source_key)
values ('wta:100','WTA','r1',88.50,0.21,1,0.8200,3,2,now(),'archive'),
       ('wta:200','WTA','r1',61.25,0.34,87,0.5100,5,1,now(),'archive');
insert into tennis.live_matches (match_id,provider,provider_match_id,tour,tournament_id,round,best_of,
                                 scheduled_at,status,home_player_id,away_player_id,home_name,away_name,is_doubles)
values ('espn:wta:9001','test','9001','WTA','wta:tq1','QF',3, now()+interval '6 hours','scheduled',
        'wta:100','wta:200','Fav Player','Dog Player',false);
insert into tennis.model_registry (model_version,feature_version,training_cutoff,status,source_key)
values ('wta_archive_v1','tennis-features-1.0.0','2026-01-01','candidate','archive'),
       ('wta_licensed_v1','tennis-features-1.0.0','2026-01-01','candidate','odds_api');
insert into tennis.model_predictions (match_scope,match_ref,tour,model_version,feature_version,generated_at,
       player_a_id,player_b_id,player_a_name,player_b_name,prob_a,prob_b,market_prob_a,market_prob_b,confidence,research_grade)
values ('live','espn:wta:9001','WTA','wta_archive_v1','tennis-features-1.0.0', now() - interval '2 hours',
        'wta:100','wta:200','Fav Player','Dog Player',0.78,0.22,0.7400,0.2600,0.810,'research');
insert into tennis.matches (match_id,tour,match_date,season,tournament_id,source_tourney_id,match_num,
                            winner_id,loser_id,surface,round_order,source_match_uid,score,source_key)
select 'wta:h'||g,'WTA', date '2026-03-01'+g, 2026,'wta:tq1','stq1',100+g,
       case when g%5=0 then 'wta:200' else 'wta:100' end,
       case when g%5=0 then 'wta:100' else 'wta:200' end,
       'hard',1,'uh'||g,
       case when g%7=0 then '6-4 RET' when g%3=0 then '7-6 3-6 6-4' else '6-4 6-2' end,'archive'
  from generate_series(1,20) g;`);
chk('a WTA match seeds end to end', seed.status === 0, String(seed.stderr || '').slice(0, 300));

eq('the board produces exactly one research row', q('select count(*) from wta.daily_research'), '1');

const row = (col) => q(`select ${col} from wta.daily_research`);
eq('the FAVOURITE is the model’s pick, not the higher seed', row('fav_id'), 'wta:100');
eq('and the underdog is the other one', row('dog_id'), 'wta:200');
eq('ranks are carried through', row('fav_rank') + '/' + row('dog_rank'), '1/87');
eq('the rank gap is arithmetic, not a bucket', row('rank_gap'), '86');
eq('the surface comes from the tournament', row('surface'), 'hard');
eq('the tournament title is the card heading', row('tourney_title'), 'Test Open');

/* THE COMPONENTS, each hand-computed from the seed above. A view returning
   the right columns full of wrong numbers is the worse failure. */
near('gap = 86 places x 0.10', q("select (components->>'gap')::numeric from wta.daily_research"), 8.6);
near('dominance = (88.50 - 61.25) x 0.50', q("select (components->>'dominance')::numeric from wta.daily_research"), 13.6);
near('upset = 0, because the model agrees with the rankings',
  q("select (components->>'upset')::numeric from wta.daily_research"), 0);
near('surface = (0.800 - 0.200) x 15', q("select (components->>'surface')::numeric from wta.daily_research"), 9.0);
near('form = (0.8200 - 0.5100) x 15', q("select (components->>'form')::numeric from wta.daily_research"), 4.65);
eq('and the research score is their sum, rounded', row('research_score'), '36');
eq('which bands to "watch"', row('grade'), 'watch');

near('the favourite price is the reciprocal of the captured market probability',
  row('fav_dec'), 1.35);
eq('the ranking date is the one on file', row('ranking_as_of'), '2026-09-15');

eq('every summary line is a sentence about a number in the row',
  q("select cardinality(summary) from wta.daily_research"), '4');
chk('and one of them states the model’s own probability',
  /gives Fav Player 78%/.test(q("select array_to_string(summary,' | ') from wta.daily_research")),
  q("select array_to_string(summary,' | ') from wta.daily_research"));

/* `rates` is parsed from the stored scorelines: 2 of 20 retire, 6 of 20 go
   three sets, and those same 6 carry a tiebreak. */
eq('retirement rate is read off the scorelines', q("select (rates->>'ret_pct')::int from wta.daily_research"), '10');
eq('three-set rate too', q("select (rates->>'three_set_pct')::int from wta.daily_research"), '30');
eq('over a stated window', q("select rates->>'matches' from wta.daily_research"), '20');

/* ---- 4. the licence travels with the row ------------------------------- */
eq('a row from an ARCHIVE-trained model is NOT marked sellable',
  row('commercial_ok'), 'f');
/* PREDICTIONS ARE APPEND-ONLY — the record contract refuses an UPDATE to one,
   even by the pipeline. So a re-price is a NEW row, and the board takes the
   latest. Writing the test any other way would have "passed" against an
   UPDATE the database silently refused. */
const priced = run(`insert into tennis.model_predictions (match_scope,match_ref,tour,model_version,feature_version,generated_at,
       player_a_id,player_b_id,player_a_name,player_b_name,prob_a,prob_b,market_prob_a,market_prob_b,confidence,research_grade)
     values ('live','espn:wta:9001','WTA','wta_licensed_v1','tennis-features-1.0.0', now() - interval '1 hour',
             'wta:100','wta:200','Fav Player','Dog Player',0.78,0.22,0.7400,0.2600,0.810,'research');`);
chk('a re-price appends rather than rewriting', priced.status === 0, String(priced.stderr || '').slice(0, 200));
eq('the board still shows one row per match (the latest prediction)',
  q('select count(*) from wta.daily_research'), '1');
eq('and once a LICENSED model prices it, the row is marked sellable',
  row('commercial_ok'), 't');

/* ---- 5. an excluded match stays visible as excluded --------------------- */
const excl = run(`insert into tennis.model_predictions (match_scope,match_ref,tour,model_version,feature_version,generated_at,
       player_a_id,player_b_id,player_a_name,player_b_name,prob_a,prob_b,market_prob_a,market_prob_b,confidence,
       research_grade,exclusion_reasons,feature_snapshot_at)
     values ('live','espn:wta:9001','WTA','wta_licensed_v1','tennis-features-1.0.0', now(),
             'wta:100','wta:200','Fav Player','Dog Player',0.78,0.22,0.7400,0.2600,0.810,
             'excluded', array['no market captured'], now());`);
chk('an exclusion is appended too', excl.status === 0, String(excl.stderr || '').slice(0, 200));
eq('a match the pipeline excluded is graded hidden, not dropped', row('grade'), 'hidden');
eq('and its reason is published as a chip rather than reworded',
  q("select disqualifiers->0->>'label' from wta.daily_research"), 'no market captured');

/* ---- 5b. held back on score is NOT the same as excluded ----------------
   A row below the qualifying floor grades 'hidden', which the page renders as
   "Excluded". Without a chip saying why, that reads as a judgement the
   pipeline never made. The panel's own standard is that every excluded count
   is accountable. */
run(`insert into tennis.model_predictions (match_scope,match_ref,tour,model_version,feature_version,generated_at,
       player_a_id,player_b_id,player_a_name,player_b_name,prob_a,prob_b,market_prob_a,market_prob_b,confidence,research_grade)
     values ('live','espn:wta:9002','WTA','wta_licensed_v1','tennis-features-1.0.0', now(),
             'wta:200','wta:100','Dog Player','Fav Player',0.51,0.49,0.5000,0.5000,0.400,'research');
     insert into tennis.live_matches (match_id,provider,provider_match_id,tour,tournament_id,round,best_of,
            scheduled_at,status,home_player_id,away_player_id,home_name,away_name,is_doubles)
     values ('espn:wta:9002','test','9002','WTA','wta:tq1','R16',3, now()+interval '8 hours','scheduled',
             'wta:200','wta:100','Dog Player','Fav Player',false);`);
const low = (col) => q(`select ${col} from wta.daily_research where match_ref='espn:wta:9002'`);
chk('an evenly-matched fixture scores below the floor',
  parseInt(low('research_score'), 10) < 30, low('research_score'));
eq('and is held back rather than shown as research', low('grade'), 'hidden');
chk('BUT IT SAYS WHY — a bare "Excluded" would be a claim the pipeline never made',
  /below the qualifying floor/.test(low("disqualifiers->0->>'label'")), low("disqualifiers->0->>'label'"));
chk('while a genuinely excluded row still carries the pipeline\u2019s own reason',
  q("select disqualifiers->0->>'label' from wta.daily_research where match_ref='espn:wta:9001'") === 'no market captured');

/* ---- 6. the watchlist, and the mirror ---------------------------------- */
run(`insert into tennis.prediction_record (match_scope,match_ref,tour,model_version,player_a_id,player_b_id,
       player_a_name,player_b_name,prob_a,scheduled_at,surface,tournament_name,research_grade,
       closing_prob_a,clv,beat_close,settled_at,winner_id,outcome_a)
     select 'live','espn:wta:r'||g,'WTA','wta_archive_v1','wta:100','wta:200','Fav Player','Dog Player',
            0.70, now()-(g||' days')::interval,'hard','Test Open',
            case when g%4=0 then 'excluded' else 'research' end,
            0.66, 0.040, (g%3<>0), now()-(g||' days')::interval+interval '2 hours',
            case when g%3=0 then 'wta:200' else 'wta:100' end, (g%3<>0)
       from generate_series(1,12) g;`);
eq('both sides of every graded match reach the watchlist',
  q('select count(*) from wta.watchlist'), '2');
const w = (col, pid) => q(`select ${col} from wta.watchlist where player_id='${pid}'`);
eq('appearances count distinct slate dates', w('appearances', 'wta:100'), '12');
near('CLV is averaged over graded events only', w('clv_avg', 'wta:100'), 0.04);
near('AND THE OTHER SIDE CARRIES ITS MIRROR — one player’s closing gain is the other’s loss',
  w('clv_avg', 'wta:200'), -0.04);
near('beat-close rate is a share, not a count', w('beat_close_rate', 'wta:100'), 0.6667);
near('and its mirror too', w('beat_close_rate', 'wta:200'), 0.3333);
near('reliability is the share graded fit to research (9 of 12)', w('reliability', 'wta:100'), 0.75);
eq('the watchlist carries the official rank', w('rank', 'wta:100'), '1');
chk('surface edge is published per surface', /hard/.test(w('surface_edge', 'wta:100')), w('surface_edge', 'wta:100'));

/* ---- 7. nothing here widens who may read what -------------------------- */
eq('every wta view is security_invoker, so the paywall still decides',
  q(`select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='wta' and c.relkind='v'
        and coalesce(array_to_string(c.reloptions,','),'') like '%security_invoker=true%'`), '3');
eq('and there are no TABLES in wta — it is views over the record, not a second store',
  q("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='wta' and c.relkind='r'"), '0');

failures.forEach((f) => console.log('  FAIL  ' + f));
console.log((fail === 0 ? 'PASS | ' : 'FAILED | ') + 'wta board SQL | ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
