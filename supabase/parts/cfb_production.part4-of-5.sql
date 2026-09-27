-- cfb_production -- part 4 of 5.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- ============================================================ triggers, RLS, grants
-- Created only when missing: DROP TRIGGER and ENABLE ROW LEVEL SECURITY take
-- ACCESS EXCLUSIVE, which a re-apply against live tables must not.
do $blk$
declare
  t text;
  v_rel regclass;
begin
  foreach t in array array['cfb_production_model_manifest','cfb_compatibility_matrix','cfb_audit_log','cfb_data_corrections',
    'cfb_job_heartbeats','cfb_job_lock_events','cfb_incidents']
  loop
    v_rel := to_regclass('public.' || t);
    if not exists (select 1 from pg_trigger where tgrelid = v_rel and tgname = t || '_no_update_trg') then
      execute format('create trigger %I before update on public.%I for each row execute function public.cfb_prod_append_only()', t || '_no_update_trg', t);
    end if;
    if not exists (select 1 from pg_trigger where tgrelid = v_rel and tgname = t || '_no_delete_trg') then
      execute format('create trigger %I before delete on public.%I for each row execute function public.cfb_prod_append_only()', t || '_no_delete_trg', t);
    end if;
    if not exists (select 1 from pg_trigger where tgrelid = v_rel and tgname = t || '_no_truncate_trg') then
      execute format('create trigger %I before truncate on public.%I for each statement execute function public.cfb_prod_append_only()', t || '_no_truncate_trg', t);
    end if;
  end loop;

  v_rel := to_regclass('public.cfb_audit_log');
  if not exists (select 1 from pg_trigger where tgrelid = v_rel and tgname = 'cfb_audit_log_chain_trg') then
    create trigger cfb_audit_log_chain_trg before insert on public.cfb_audit_log for each row execute function public.cfb_audit_chain();
  end if;
  v_rel := to_regclass('public.cfb_feature_flags');
  if not exists (select 1 from pg_trigger where tgrelid = v_rel and tgname = 'cfb_feature_flags_guard_trg') then
    create trigger cfb_feature_flags_guard_trg before update or delete on public.cfb_feature_flags for each row execute function public.cfb_feature_flags_guard();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = v_rel and tgname = 'cfb_feature_flags_no_truncate_trg') then
    create trigger cfb_feature_flags_no_truncate_trg before truncate on public.cfb_feature_flags for each statement execute function public.cfb_feature_flags_guard();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = v_rel and tgname = 'cfb_feature_flags_audit_trg') then
    create trigger cfb_feature_flags_audit_trg after insert or update on public.cfb_feature_flags for each row execute function public.cfb_feature_flags_audit();
  end if;
  v_rel := to_regclass('public.cfb_production_model_manifest');
  if not exists (select 1 from pg_trigger where tgrelid = v_rel and tgname = 'cfb_manifest_audit_trg') then
    create trigger cfb_manifest_audit_trg after insert on public.cfb_production_model_manifest for each row execute function public.cfb_manifest_audit();
  end if;
  v_rel := to_regclass('public.cfb_compatibility_matrix');
  if not exists (select 1 from pg_trigger where tgrelid = v_rel and tgname = 'cfb_compat_audit_trg') then
    create trigger cfb_compat_audit_trg after insert on public.cfb_compatibility_matrix for each row execute function public.cfb_compat_audit();
  end if;
end $blk$;

do $blk$
declare
  t text;
begin
  foreach t in array array['cfb_production_model_manifest','cfb_compatibility_matrix','cfb_audit_log','cfb_feature_flags',
    'cfb_data_corrections','cfb_job_registry','cfb_job_heartbeats','cfb_job_locks','cfb_job_lock_events','cfb_incidents','cfb_freshness_rules']
  loop
    if not (select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.' || t)) then
      execute format('alter table public.%I enable row level security', t);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_read') then
      execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_read', t);
    end if;
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on table public.%I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke insert, update, delete, truncate, references, trigger on table public.%I from authenticated', t);
      execute format('grant select on table public.%I to authenticated', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke insert, update, delete, truncate, references, trigger on table public.%I from service_role', t);
      execute format('grant select on table public.%I to service_role', t);
    end if;
  end loop;
  -- the two rows a job inserts directly (PostgREST, ignore-duplicates); everything else goes through a function
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant insert on table public.cfb_production_model_manifest to service_role';
    execute 'grant insert on table public.cfb_compatibility_matrix to service_role';
  end if;
end $blk$;

do $blk$
declare
  f text;
begin
  foreach f in array array['public.cfb_audit(text,text,jsonb,jsonb,text,text,text)', 'public.cfb_audit_verify()',
    'public.cfb_set_feature_flag(text,boolean,text,text,text)', 'public.cfb_record_correction(text,jsonb,text,jsonb,text,text,text)',
    'public.cfb_revoke_correction(text,text,text)', 'public.cfb_corrected(text,jsonb,text,jsonb)',
    'public.cfb_job_lock(text,text,text,integer,text)', 'public.cfb_job_lock_renew(text,text,text,integer)', 'public.cfb_job_unlock(text,text,text)',
    'public.cfb_heartbeat(text,text,text,text,bigint,jsonb)', 'public.cfb_record_incident(text,text,text,text,text,text,jsonb)',
    'public.cfb_resolve_incident(text,text,text)', 'public.cfb_is_compatible(text,text,text,text,text,text)',
    'public.cfb_assert_compatible(text,text,text,text,text,text)']
  loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $blk$;

-- ============================================================ seeds
-- Flags: inserted once and never overwritten by a re-apply (a person's switch stays switched).
insert into public.cfb_feature_flags (flag, enabled, kind, guarded, description, updated_by, reason) values
  ('cfb_weekly_engine_enabled', true, 'KILL_SWITCH', false,
   'Kill switch for the scheduled weekly refresh (cfb-v2-shadow.yml). Off: the gate skips the engine and the mirror; the last published state stays.',
   'cfb_production seed', 'initial state: the weekly engine runs on its schedule'),
  ('cfb_model_lab_enabled', true, 'KILL_SWITCH', false,
   'Kill switch for the hourly Model Lab job (cfb-lab.yml). Off: no checkpoint snapshots are taken (a missed window is never re-taken).',
   'cfb_production seed', 'initial state: the Model Lab runs hourly in season'),
  ('cfb_v21_pure_model_enabled', true, 'COMPONENT', false,
   'The V2.1 pure model (edgedesk_cfb_v2.1.0) produces weekly projections. Off: the fallback hierarchy serves V1 (the governance champion).',
   'cfb_production seed', 'initial state: V2.1 projects in shadow, V1 is champion'),
  ('cfb_v1_fallback_enabled', true, 'COMPONENT', false,
   'V1 (edgedesk_cfb_p4_v1.0.0), the governance champion, stays available as the fallback level of the hierarchy.',
   'cfb_production seed', 'initial state: the previous stable champion is available'),
  ('cfb_decision_engine_enabled', true, 'COMPONENT', false,
   'The wagering decision engine runs in shadow on every captured quote. Off: no decision rows are produced (status UNAVAILABLE).',
   'cfb_production seed', 'initial state: decisions in shadow under cfb_decision_policy_v0'),
  ('cfb_player_model_enabled', false, 'COMPONENT', true,
   'Personnel unit adjustments as a model input. Not part of edgedesk_cfb_v2.1.0 (a research layer); on only with a new, validated model version.',
   'cfb_production seed', 'initial state: personnel is research, not a production input'),
  ('cfb_matchup_correction_enabled', false, 'COMPONENT', true,
   'The scheme/matchup residual correction. Not part of edgedesk_cfb_v2.1.0; on only with a new, validated model version.',
   'cfb_production seed', 'initial state: the matchup correction is research, not a production input'),
  ('cfb_bet_actionable_enabled', false, 'BETTING', true,
   'Official BET output. Off: every decision is PASS / LEAN with NO_BET_BETTING_DISABLED. Cannot be switched on while the manifest''s decision policy has betting disabled.',
   'cfb_production seed', 'initial state: cfb_decision_policy_v0 is an UNVALIDATED_DEFAULT with betting disabled')
on conflict (flag) do nothing;

-- The job registry is reference data (football/cfb_production/jobs.json; sql.test.js proves they agree).
-- BEGIN jobs.json seed (generated: node football/cfb_production/jobs.js --seed-sql)
insert into public.cfb_job_registry (job, workflow, trigger_kind, schedule, season_months, max_silence_minutes, expected_minutes,
  timeout_minutes, lock_scope, severity_on_miss, purpose) values
  ('cfb_lab_hourly', '.github/workflows/cfb-lab.yml', 'pg_cron+github_schedule', 'cfb_lab_hourly 7 * * * * (pg_cron) | 37 * * 8-12,1 * (github)', '{8,9,10,11,12,1}', 150, 1, 30, 'cfb_lab_hourly/<season>', 'CRITICAL', 'Model Lab: market capture, checkpoint snapshots, settlement, reports; decision shadow; mirror to Supabase'),
  ('cfb_weekly_refresh', '.github/workflows/cfb-v2-shadow.yml', 'pg_cron+github_schedule', 'cfb_weekly_sunday 5 10 * 8-12,1 0 (pg_cron) | cfb_weekly_monday 5 10 * 8-12,1 1 (pg_cron) | cfb_weekly_freeze 7 12 * 8-12,1 2 (pg_cron) | cfb_weekly_daily 47 10 * 8-12,1 3-6 (pg_cron) | 5 10 * 8-12,1 0,1 (github) | 17 12 * 8-12,1 2 (github) | 47 10 * 8-12,1 3-6 (github)', '{8,9,10,11,12,1}', 1560, 35, 90, 'cfb_weekly_refresh/<season>', 'CRITICAL', 'Weekly engine: validate finals and PBP, team/QB/unit state, V2.1 projections, EARLY freeze, mirror to Supabase'),
  ('cfb_v1_board_build', '.github/workflows/football-weekly-build.yml', 'github_schedule', '40 9 * 8-12,1 * (github) | 20 */2 * 8-12,1 * (github) | 40 9 * 2-7 2 (github)', '{8,9,10,11,12,1}', 1560, 3, 90, 'none (concurrency group football-weekly-build)', 'WARNING', 'V1 champion board (football/fbs/slate.json): the fallback level and the Model Lab V1 adapter input'),
  ('cfb_enrichment', '.github/workflows/football-enrichment.yml', 'github_schedule', '25 * * 9-12,1 6 (github) | 25 0-5 * 9-12,1 0 (github) | 25 */2 * 9-12,1 5 (github) | 25 */6 * 9-12,1 0-4 (github)', '{9,10,11,12,1}', 480, 10, 30, 'none (concurrency group football-weekly-build)', 'WARNING', 'V1 board enrichment: availability, starters, weather for the board'),
  ('cfb_odds_capture', 'supabase/capture_cron.sql', 'pg_cron', 'capture_near */10 * * * * (pg_cron) | capture_day 4,34 * * * * (pg_cron) | capture_board 18 */4 * * * (pg_cron)', '{8,9,10,11,12,1}', 60, 1, 5, 'row-level + advisory xact lock cfb_lab_ingest_quotes', 'CRITICAL', 'Per-sportsbook odds capture (edge function capture) into cfb_lab_market_quotes via cfb_lab_ingest_quotes()'),
  ('cfb_football_record', '.github/workflows/football-model-record.yml', 'github_schedule', '47 * * 8-12,1 * (github) | 47 12 * 2-7 1 (github)', '{8,9,10,11,12,1}', 150, 5, 30, 'none (concurrency group football-model-record)', 'WARNING', 'Public football record: settles V1 projections against finals'),
  ('cfb_availability_sync', '.github/workflows/availability-sync.yml', 'github_schedule', '5 * * * 6 (github) | 5 0-5 * * 0 (github) | 5 6,12,18 * * 0,1 (github) | 5 */3 * * 2,3,4 (github) | 5 * * * 5 (github) | 5 22,23 * * 2,3,4 (github) | 5 1,2 * * 3,4,5 (github)', '{8,9,10,11,12,1}', 480, 10, 30, 'none (concurrency group availability-sync)', 'WARNING', 'Injury / availability reports (source for QB status and the injury-source freshness rule)'),
  ('cfb_starter_context', '.github/workflows/starter-context.yml', 'github_schedule', '20 7,19 * * 0,1 (github) | 20 13 * * 2,3,4,5 (github) | 20 13,21 * * 6 (github)', '{8,9,10,11,12,1}', 1560, 15, 45, 'none (concurrency group starter-context)', 'WARNING', 'QB starter context (football/starters/cfb_<season>.json): the QB-status source'),
  ('cfb_roster_sync', '.github/workflows/roster-sync.yml', 'github_schedule', '0 10 * * 1 (github)', '{8,9,10,11,12,1}', 11520, 10, 360, 'none (concurrency group roster-sync)', 'INFO', 'Weekly roster sync (football/rosters): roster freshness bound 8 days')
-- END jobs.json seed
on conflict (job) do update set workflow = excluded.workflow, trigger_kind = excluded.trigger_kind, schedule = excluded.schedule,
  season_months = excluded.season_months, max_silence_minutes = excluded.max_silence_minutes, expected_minutes = excluded.expected_minutes,
  timeout_minutes = excluded.timeout_minutes, lock_scope = excluded.lock_scope, severity_on_miss = excluded.severity_on_miss,
  purpose = excluded.purpose, updated_at = now()
where (public.cfb_job_registry.workflow, public.cfb_job_registry.trigger_kind, public.cfb_job_registry.schedule, public.cfb_job_registry.season_months,
       public.cfb_job_registry.max_silence_minutes, public.cfb_job_registry.expected_minutes, public.cfb_job_registry.timeout_minutes,
       public.cfb_job_registry.lock_scope, public.cfb_job_registry.severity_on_miss, public.cfb_job_registry.purpose)
   is distinct from (excluded.workflow, excluded.trigger_kind, excluded.schedule, excluded.season_months, excluded.max_silence_minutes,
       excluded.expected_minutes, excluded.timeout_minutes, excluded.lock_scope, excluded.severity_on_miss, excluded.purpose);

-- Freshness: the bounds the engines already use, gathered in one place (never retuned here).
insert into public.cfb_freshness_rules (source, warn_minutes, critical_minutes, applies, basis) values
  ('odds', 180, 360, 'in season, while a game kicks off within 48 h',
   'warn = cfb_decision_policy_v0 stale_minutes (a decision fails closed as MARKET_STALE); critical = the weekly engine market bound (6 h)'),
  ('pbp', 2160, 10080, 'in season',
   'weekly engine: a game past kickoff + 36 h needs a final; the PBP source must advance weekly (7 d critical)'),
  ('qb_status', 2160, 4320, 'in season', 'weekly engine qb_status bound 36 h; Model Lab qb_status_freshness 72 h'),
  ('injury', 720, 4320, 'in season', 'weekly engine injury bound 12 h; Model Lab injury_freshness 72 h'),
  ('roster', 11520, 20160, 'in season', 'weekly engine roster bound 8 days'),
  ('team_state', 11520, 21600, 'in season', 'one weekly refresh per week (8 d warn, 15 d critical)'),
  ('weekly_projection', 11520, 21600, 'in season', 'one EARLY freeze per week (8 d warn, 15 d critical)')
on conflict (source) do update set warn_minutes = excluded.warn_minutes, critical_minutes = excluded.critical_minutes,
  applies = excluded.applies, basis = excluded.basis
where (public.cfb_freshness_rules.warn_minutes, public.cfb_freshness_rules.critical_minutes, public.cfb_freshness_rules.applies, public.cfb_freshness_rules.basis)
   is distinct from (excluded.warn_minutes, excluded.critical_minutes, excluded.applies, excluded.basis);

-- ============================================================ published (committed) weekly state
-- The weekly mirror writes the run row LAST (football/cfb_weekly/sync_supabase.js),
-- so state whose run row is absent belongs to a mirror still in flight or cut
-- short; these views show only state and projections of PUBLISHED runs.
do $blk$
begin
  if to_regclass('public.cfb_team_week_state') is not null and to_regclass('public.cfb_pipeline_runs') is not null then
    execute $v$
      create or replace view public.cfb_team_week_state_published as
      select distinct on (s.team_id, s.season, s.week, s.feature_version) s.*
        from public.cfb_team_week_state s
        join public.cfb_pipeline_runs r on r.run_id = s.run_id and r.published and r.status = 'PUBLISHED'
       order by s.team_id, s.season, s.week, s.feature_version, s.state_version desc
    $v$;
  end if;
  if to_regclass('public.cfb_weekly_projections') is not null and to_regclass('public.cfb_pipeline_runs') is not null then
    execute $v$
      create or replace view public.cfb_weekly_projections_published as
      select p.*
        from public.cfb_weekly_projections p
        join public.cfb_pipeline_runs r on r.run_id = p.run_id and r.published and r.status = 'PUBLISHED'
    $v$;
  end if;
end $blk$;

-- ============================================================ evidence-based indexes
-- Only where a measured read path missed its budget (football/cfb_production/perf.js,
-- reports/perf.json, OPERATIONS.md §3): the weekly decision summary (Model Lab
-- scorecard, dashboards) seq-scans cfb_decision_snapshots — p95 299 ms under write
-- load at ONE season (624 000 rows) against a 200 ms budget. Created once, only when
-- missing (a re-apply takes no lock); the first build holds a SHARE lock on the
-- table for about a second per million rows (inserts wait, reads do not).
do $blk$
begin
  if to_regclass('public.cfb_decision_snapshots') is not null and to_regclass('public.cfb_prod_decision_week_idx') is null then
    execute 'create index cfb_prod_decision_week_idx on public.cfb_decision_snapshots (season, week)';
  end if;
end $blk$;
