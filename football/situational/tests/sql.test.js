#!/usr/bin/env node
/* ============================================================================
   FSIE SQL on a throwaway PostgreSQL (tools/personal/_pg.js, the Supabase
   shim): the migration applies twice cleanly and reports ok; anon reads
   nothing, signed-in readers read, only the service role writes; write-once
   tables refuse updates; a shadow row cannot apply points unless ACTIVE; a
   CLV row needs a close or an exclusion reason; projections are pregame;
   the rollback removes everything. The registry file is current with its
   generator and registers four EXPERIMENTAL models, idempotently, against two
   live registry shapes.
   Without a PostgreSQL binary the live layer is NOT VERIFIED (exit 0 with a
   loud note, per AGENTS.md: skipped is not passed).
   Run: node football/situational/tests/sql.test.js
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const H = require('./_harness.js');
const PG = require(path.join(__dirname, '..', '..', '..', 'tools', 'personal', '_pg.js'));
const T = H.kit('fsie sql');
const chk = T.chk;
const ROOT = PG.ROOT;
const MIG = path.join(ROOT, 'supabase', 'football_situational.sql');
const RB = path.join(ROOT, 'supabase', 'football_situational_rollback.sql');
const REG = path.join(ROOT, 'supabase', 'football_situational_registry.sql');
const SQL = fs.readFileSync(MIG, 'utf8');

chk('no psql meta-commands', !/^\\/m.test(SQL) && !/^\\/m.test(fs.readFileSync(RB, 'utf8')));
chk('the migration ends in a report', /CHECK THIS/.test(SQL));
chk('no destructive statement in the migration', !/\bdrop\s+table\b|\btruncate\b|\bdelete\s+from\s+public\.(?!fsie_(pipeline_runs|quality_failures|coverage))/i.test(SQL));
chk('the registry file exists and is current with its generator', fs.existsSync(REG) && cp.spawnSync(process.execPath, [path.join(ROOT, 'tools', 'football', 'build_fsie_registry_sql.js'), '--check']).status === 0);
const REGSQL = fs.existsSync(REG) ? fs.readFileSync(REG, 'utf8') : '';
chk('the registry never writes a status past experimental (every status label it writes is experimental)', !/edr_label\([^;]*'validat/i.test(REGSQL) && (REGSQL.match(/edr_label\([mv], c, array\['experimental'\]\)/g) || []).length === 8);

const db = PG.start('fsie');
if (db.skip) { console.log('NOT VERIFIED | ' + db.skip + ' — the live SQL layer did not run'); process.exit(T.done()); }
try {
  let out = db.applyFileAtomic(MIG);
  chk('the migration applies and every report row says ok', !/CHECK THIS/.test(out), out.slice(-600));
  out = db.applyFileAtomic(MIG);
  chk('it applies again cleanly (idempotent)', !/CHECK THIS/.test(out));
  const must = (fn) => { try { fn(); return false; } catch (_) { return true; } };
  db.service("insert into public.fsie_shadow_integrations (sport,game_id,target,mode,model_version,as_of,existing,applied_points) values ('nfl','g1','nfl_slate','SHADOW','v1',now(),'{}'::jsonb,0);");
  chk('a SHADOW row with points applied is refused', must(() => db.service("insert into public.fsie_shadow_integrations (sport,game_id,target,mode,model_version,as_of,existing,applied_points) values ('nfl','g2','nfl_slate','SHADOW','v1',now(),'{}'::jsonb,1.5);")));
  chk('write-once: an update is refused', must(() => db.service("update public.fsie_shadow_integrations set mode='ACTIVE';")));
  chk('write-once: a delete is refused', must(() => db.service('delete from public.fsie_shadow_integrations;')));
  chk('anon reads nothing', must(() => db.anon('select count(*) from public.fsie_shadow_integrations;')));
  chk('a signed-in reader reads', db.as('00000000-0000-0000-0000-000000000001', 'select count(*) from public.fsie_shadow_integrations;').trim() === '1');
  chk('a signed-in reader cannot write', must(() => db.as('00000000-0000-0000-0000-000000000001', "insert into public.fsie_pipeline_runs (run_id,sport,stage,started_at,status) values ('r','nfl','x',now(),'ok');")));
  chk('a CLV row without a close needs an exclusion reason', must(() => db.service("insert into public.fsie_clv_evaluations (clv_id,sport,game_id,player_id,market,direction,entry_line,entry_at,model_as_of,close_available) values ('c1','nfl','g','p','pass_att','over',33.5,now(),now(),false);")));
  db.service("insert into public.fsie_clv_evaluations (clv_id,sport,game_id,player_id,market,direction,entry_line,entry_at,model_as_of,close_available,exclusion_reason) values ('c2','nfl','g','p','pass_att','over',33.5,now(),now() - interval '1 day',false,'no pregame close captured for this prop');");
  chk('a CLV row whose model postdates its entry is refused', must(() => db.service("insert into public.fsie_clv_evaluations (clv_id,sport,game_id,player_id,market,direction,entry_line,entry_at,model_as_of,close_available,exclusion_reason) values ('c3','nfl','g','p','pass_att','over',33.5,now(),now() + interval '1 day',false,'x');")));
  chk('a projection made after kickoff is refused', must(() => db.service("insert into public.fsie_team_projections (projection_id,sport,season,week,game_id,team_id,opponent_id,model_key,model_version,as_of,kickoff_at,point,p10,p50,p90,data_quality) values ('p1','nfl',2026,9,'g','A','B','k','v',now(),now() - interval '1 hour','{}','{}','{}','{}','ok');")));
  chk('a non-experimental projection is refused', must(() => db.service("insert into public.fsie_team_projections (projection_id,sport,season,week,game_id,team_id,opponent_id,model_key,model_version,as_of,kickoff_at,point,p10,p50,p90,data_quality,experimental) values ('p2','nfl',2026,9,'g','A','B','k','v',now(),now() + interval '1 day','{}','{}','{}','{}','ok',false);")));
  chk('a player interval out of order is refused', must(() => db.service("insert into public.fsie_player_projections (projection_id,sport,game_id,team_id,player_id,market,model_version,as_of,mean,p10,p50,p90) values ('pp','nfl','g','A','p','targets','v',now(),5,6,5,9);")));
  db.service("insert into public.fsie_team_games (sport,season,week,season_type,game_id,team_id,opponent_id,source_name,source_ref,situations_version,quality_version,volume_ok,situation_ok,player_ok,quality_status,counts) values ('nfl',2026,1,'REG','g','A','B','pbp','pbp@aaa','situations_v1','quality_v1',true,true,true,'accepted','{}');");
  db.service("insert into public.fsie_team_games (sport,season,week,season_type,game_id,team_id,opponent_id,source_name,source_ref,situations_version,quality_version,volume_ok,situation_ok,player_ok,quality_status,counts) values ('nfl',2026,1,'REG','g','A','B','pbp','pbp@bbb','situations_v1','quality_v1',true,true,true,'accepted','{\"plays\":61}');");
  chk('a source revision is a new row; the current view shows the latest', db.service("select source_ref from public.fsie_team_games_current where game_id='g' and team_id='A';").trim() === 'pbp@bbb' && db.service("select count(*) from public.fsie_team_games;").trim() === '2');
  chk('the same source version twice is one row (idempotent insert)', must(() => db.service("insert into public.fsie_team_games (sport,season,week,season_type,game_id,team_id,opponent_id,source_name,source_ref,situations_version,quality_version,volume_ok,situation_ok,player_ok,quality_status,counts) values ('nfl',2026,1,'REG','g','A','B','pbp','pbp@bbb','situations_v1','quality_v1',true,true,true,'accepted','{}');")));
  chk('situation_ok without volume_ok is refused', must(() => db.service("insert into public.fsie_team_games (sport,season,week,season_type,game_id,team_id,opponent_id,source_name,source_ref,situations_version,quality_version,volume_ok,situation_ok,player_ok,quality_status,counts) values ('nfl',2026,1,'REG','h','A','B','pbp','x','s','q',false,true,false,'rejected','{}');")));
  chk('retention refuses to prune below 120 days', must(() => db.sql('select * from public.fsie_prune(30);')));
  out = db.applyFileAtomic(RB);
  chk('the rollback removes every fsie table and function', !/CHECK THIS/.test(out), out);

  /* the registry, against the production shape the repository's tests stand in for */
  if (REGSQL) {
    db.sql(`create extension if not exists pgcrypto;
      create type public.evidence_provenance as enum ('T0', 'T1', 'T2', 'T3');
      create type public.model_status as enum ('experimental', 'validating', 'validated', 'retired');
      create table public.research_models (id uuid primary key default gen_random_uuid(), model_key text unique not null, name text not null, sport text,
        provenance public.evidence_provenance not null, objective text, created_at timestamptz not null default now());
      create table public.research_model_versions (id bigserial primary key, model_id uuid not null references public.research_models (id), version text not null,
        status public.model_status not null default 'experimental', training_window daterange, validation_window daterange, holdout_window daterange,
        objective text, min_sample integer, success_metric text, forking_paths jsonb, promotion_criteria jsonb, spec jsonb, created_at timestamptz not null default now());
      create table public.research_model_results (id bigserial primary key, version_id bigint references public.research_model_versions (id), passed boolean, metrics jsonb,
        computed_at timestamptz not null default now());
      create view public.research_model_current as
        select m.model_key, m.name, m.provenance, v.version, v.status, r.passed, r.metrics as holdout_result
          from public.research_models m
          join lateral (select * from public.research_model_versions x where x.model_id = m.id order by x.created_at desc limit 1) v on true
          left join lateral (select * from public.research_model_results y where y.version_id = v.id order by y.computed_at desc limit 1) r on true;`);
    out = db.applyFileAtomic(REG);
    chk('the registry applies and every report row says ok', !/CHECK THIS/.test(out), out.slice(-800));
    chk('four EXPERIMENTAL models, T3', db.sql("select count(*) from public.research_model_current where model_key like 'fsie_%' and status = 'experimental' and provenance = 'T3';").trim() === '4');
    chk('windows are written as date ranges', db.sql("select count(*) from public.research_model_versions where holdout_window is not null and training_window is not null;").trim() === '4');
    const nRes = (REGSQL.match(/"study_id":/g) || []).length;
    chk('one result row per evaluated model version', db.sql('select count(*) from public.research_model_results;').trim() === String(nRes));
    out = db.applyFileAtomic(REG);
    chk('applying it again changes nothing', db.sql("select count(*) from public.research_models where model_key like 'fsie_%';").trim() === '4' && db.sql('select count(*) from public.research_model_results;').trim() === String(nRes) && !/CHECK THIS/.test(out));
  }
} finally { db.stop(); }
process.exit(T.done());
