-- cfb_lab -- part 5 of 6.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- ============================================================= model roles
-- cfb_lab_set_role(model, label, role, reason, actor): one role event and one
-- audit event (MODEL_PROMOTED for champion, MODEL_RETIRED for retired,
-- ROLE_CHANGED otherwise). Promoting a champion first demotes the sitting
-- champion to 'challenger' with its own role and audit events. Setting a
-- model to the role it already holds writes nothing.
-- Ids: role event 'cfbg_' + h('model_roles', model, role, effective_at, actor);
--      audit event 'cfbg_' + h('audit_log', event_type, model, created_at, actor).
create or replace function public.cfb_lab_set_role(p_model text, p_label text, p_role text, p_reason text, p_actor text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_prev   record;
  v_old    record;
  v_at     timestamptz;
  v_ev     text;
  v_events jsonb := '[]'::jsonb;
  v_demoted jsonb := '[]'::jsonb;
  v_type   text;
begin
  if coalesce(p_model, '') = '' then
    raise exception 'cfb_lab_set_role: a model_version is required' using errcode = 'invalid_parameter_value';
  end if;
  if p_role is null or p_role not in ('champion','challenger','candidate','retired') then
    raise exception 'cfb_lab_set_role: role must be champion, challenger, candidate or retired' using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(p_actor, '') = '' then
    raise exception 'cfb_lab_set_role: an actor is required (a person changes roles, never a job)' using errcode = 'invalid_parameter_value';
  end if;
  perform pg_advisory_xact_lock(hashtext('cfb_lab_set_role'));

  select r.* into v_prev from public.cfb_lab_model_roles r
   where r.model_version = p_model
   order by r.effective_at desc, r.recorded_at desc, r.event_id desc limit 1;
  if found and v_prev.role = p_role then
    return jsonb_build_object('ok', true, 'changed', false, 'model_version', p_model, 'role', p_role,
      'reason', 'already ' || p_role);
  end if;

  if p_role = 'champion' then
    for v_old in
      select c.* from (
        select distinct on (r.model_version) r.*
          from public.cfb_lab_model_roles r
         where r.model_version <> p_model
         order by r.model_version, r.effective_at desc, r.recorded_at desc, r.event_id desc) c
       where c.role = 'champion'
    loop
      v_at := clock_timestamp();
      v_ev := 'cfbg_' || public.cfb_lab_h('model_roles', v_old.model_version, 'challenger', public.cfb_lab_ts(v_at), p_actor);
      insert into public.cfb_lab_model_roles (event_id, model_version, model_label, role, effective_at, reason, evidence_ref, actor, supersedes)
      values (v_ev, v_old.model_version, v_old.model_label, 'challenger', v_at,
              'demoted: ' || p_model || ' promoted to champion' || coalesce(' (' || p_reason || ')', ''), null, p_actor, v_old.event_id);
      insert into public.cfb_lab_audit_log (event_id, event_type, subject, before, after, reason, actor, created_at)
      values ('cfbg_' || public.cfb_lab_h('audit_log', 'ROLE_CHANGED', v_old.model_version, public.cfb_lab_ts(v_at), p_actor),
              'ROLE_CHANGED', v_old.model_version,
              jsonb_build_object('model_version', v_old.model_version, 'role', 'champion'),
              jsonb_build_object('model_version', v_old.model_version, 'role', 'challenger', 'role_event_id', v_ev),
              'demoted: ' || p_model || ' promoted to champion', p_actor, v_at);
      v_demoted := v_demoted || jsonb_build_array(v_old.model_version);
      v_events := v_events || jsonb_build_array(v_ev);
    end loop;
  end if;

  v_at := clock_timestamp();
  v_ev := 'cfbg_' || public.cfb_lab_h('model_roles', p_model, p_role, public.cfb_lab_ts(v_at), p_actor);
  insert into public.cfb_lab_model_roles (event_id, model_version, model_label, role, effective_at, reason, evidence_ref, actor, supersedes)
  values (v_ev, p_model, coalesce(p_label, v_prev.model_label), p_role, v_at, p_reason, null, p_actor, v_prev.event_id);
  v_type := case p_role when 'champion' then 'MODEL_PROMOTED' when 'retired' then 'MODEL_RETIRED' else 'ROLE_CHANGED' end;
  insert into public.cfb_lab_audit_log (event_id, event_type, subject, before, after, reason, actor, created_at)
  values ('cfbg_' || public.cfb_lab_h('audit_log', v_type, p_model, public.cfb_lab_ts(v_at), p_actor),
          v_type, p_model,
          case when v_prev.event_id is null then null
               else jsonb_build_object('model_version', p_model, 'role', v_prev.role) end,
          jsonb_build_object('model_version', p_model, 'role', p_role, 'model_label', coalesce(p_label, v_prev.model_label), 'role_event_id', v_ev),
          p_reason, p_actor, v_at);
  v_events := v_events || jsonb_build_array(v_ev);

  return jsonb_build_object('ok', true, 'changed', true, 'model_version', p_model, 'role', p_role,
    'previous_role', v_prev.role, 'demoted', v_demoted, 'role_events', v_events, 'audit_event_type', v_type);
end $fn$;

-- ================================================================== views
-- Internal views run as the caller (security_invoker): authenticated reads
-- them because it reads the tables; anon reads neither.
create or replace view public.cfb_lab_current_roles as
select distinct on (r.model_version) r.*
  from public.cfb_lab_model_roles r
 order by r.model_version, r.effective_at desc, r.recorded_at desc, r.event_id desc;

create or replace view public.cfb_lab_official_predictions as
select p.* from public.cfb_lab_predictions p
 where p.checkpoint_type = 'T24' and p.origin = 'LIVE';

create or replace view public.cfb_lab_current_results as
select distinct on (r.game_id) r.*
  from public.cfb_lab_results r
 where not exists (select 1 from public.cfb_lab_results s where s.supersedes = r.result_id)
 order by r.game_id, r.recorded_at desc, r.result_id desc;

create or replace view public.cfb_lab_current_evaluations as
select distinct on (e.prediction_id) e.*
  from public.cfb_lab_evaluations e
 order by e.prediction_id, e.evaluated_at desc, e.recorded_at desc, e.evaluation_id desc;

-- The latest ordinary pregame quote per source / book / game / market (quotes
-- that carry a game_id), and per game and market the median over them
-- (provider averages left out when a real book is quoted; for a total the
-- prices are the over and under). A reading aid; the lines table is the record.
create or replace view public.cfb_lab_consensus_now as
with latest as (
  select distinct on (q.source, q.book, q.game_id, q.market_type) q.*
    from public.cfb_lab_market_quotes q
   where q.game_id is not null and q.is_pregame and not q.is_provider_open and not q.is_provider_close
   order by q.source, q.book, q.game_id, q.market_type, q.observed_at desc, q.quote_id desc
), used as (
  select l.* from latest l
   where lower(l.book) <> 'consensus'
      or not exists (select 1 from latest r where r.game_id = l.game_id and r.market_type = l.market_type and lower(r.book) <> 'consensus')
)
select u.game_id, u.market_type,
       max(u.kickoff_ts) as kickoff_ts,
       count(*) as n_quotes,
       count(distinct u.source || ':' || u.book) as n_books,
       public.cfb_lab_median(array_agg(u.home_line)) as median_home_line,
       min(u.home_line) as min_home_line,
       max(u.home_line) as max_home_line,
       public.cfb_lab_median(array_agg(u.total_points)) as median_total_points,
       public.cfb_lab_median_price(array_agg(case when u.market_type = 'total' then u.price_over else u.price_home end)) as median_price_home,
       public.cfb_lab_median_price(array_agg(case when u.market_type = 'total' then u.price_under else u.price_away end)) as median_price_away,
       min(u.observed_at) as oldest_observed_at,
       max(u.observed_at) as as_of,
       array_agg(u.quote_id order by u.quote_id) as quote_ids
  from used u
 group by u.game_id, u.market_type;

-- THE PUBLIC RECORD — the only relation anon may read, with cfb_lab_public_summary.
-- One row per OFFICIAL (T24, LIVE) snapshot of a model that was champion when
-- the snapshot was taken, once it has an evaluation. Pregame numbers of a game
-- not yet graded never appear here. No internal field is exposed.
create or replace view public.cfb_lab_public_record as
select p.season, p.week, p.game_id, p.kickoff_ts, p.home_team, p.away_team, p.model_version,
       p.fair_spread_home_line, p.home_win_probability,
       e.final_home_points, e.final_away_points, e.abs_margin_error, e.brier_win, e.in_interval_80,
       p.decision_class, p.side, p.recommended_line, e.ats_result, e.clv_points
  from public.cfb_lab_predictions p
  join (select distinct on (x.prediction_id) x.*
          from public.cfb_lab_evaluations x
         order by x.prediction_id, x.evaluated_at desc, x.recorded_at desc, x.evaluation_id desc) e
    on e.prediction_id = p.prediction_id
 where p.checkpoint_type = 'T24' and p.origin = 'LIVE' and p.model_role = 'champion';

-- One row per season and one for all seasons (season NULL). VOID snapshots
-- count in n and nowhere else. Research positions are BET and LEAN.
create or replace view public.cfb_lab_public_summary as
with r as (
  select p.season, p.decision_class, e.void, e.abs_margin_error, e.brier_win, e.in_interval_80,
         e.ats_result, e.clv_points
    from public.cfb_lab_predictions p
    join (select distinct on (x.prediction_id) x.*
            from public.cfb_lab_evaluations x
           order by x.prediction_id, x.evaluated_at desc, x.recorded_at desc, x.evaluation_id desc) e
      on e.prediction_id = p.prediction_id
   where p.checkpoint_type = 'T24' and p.origin = 'LIVE' and p.model_role = 'champion'
)
select season,
       count(*)                                                                  as n,
       count(*) filter (where not void)                                          as n_settled,
       count(*) filter (where void)                                              as n_void,
       round(avg(abs_margin_error) filter (where not void), 3)                   as mae,
       round(sqrt(avg(abs_margin_error * abs_margin_error) filter (where not void)), 3) as rmse,
       round(avg(brier_win) filter (where not void), 4)                          as brier,
       round(avg(case when in_interval_80 then 1.0 else 0.0 end)
             filter (where not void and in_interval_80 is not null), 4)          as coverage_80,
       count(*) filter (where decision_class in ('BET','LEAN') and not void)     as research_positions,
       count(*) filter (where decision_class in ('BET','LEAN') and ats_result = 'WIN')  as ats_wins,
       count(*) filter (where decision_class in ('BET','LEAN') and ats_result = 'LOSS') as ats_losses,
       count(*) filter (where decision_class in ('BET','LEAN') and ats_result = 'PUSH') as ats_pushes,
       round(avg(clv_points) filter (where decision_class in ('BET','LEAN') and not void and clv_points is not null), 3) as mean_clv,
       round(avg(case when clv_points > 0 then 1.0 else 0.0 end)
             filter (where decision_class in ('BET','LEAN') and not void and clv_points is not null), 4) as positive_clv_share,
       count(*) filter (where decision_class in ('BET','LEAN') and not void and clv_points is not null) as n_clv,
       case when count(*) filter (where not void) < 30 then 'small sample'
            when count(*) filter (where not void) < 100 then 'provisional'
            else null end                                                        as sample_label
  from r
 group by grouping sets ((season), ());

do $blk$
declare v text;
begin
  foreach v in array array['cfb_lab_current_roles','cfb_lab_official_predictions','cfb_lab_current_results',
    'cfb_lab_current_evaluations','cfb_lab_consensus_now']
  loop
    execute format('alter view public.%I set (security_invoker = true)', v);
    execute format('revoke all on public.%I from public', v);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on public.%I from anon', v);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke insert, update, delete, truncate, references, trigger on public.%I from authenticated', v);
      execute format('grant select on public.%I to authenticated', v);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant select on public.%I to service_role', v);
    end if;
  end loop;
  foreach v in array array['cfb_lab_public_record','cfb_lab_public_summary']
  loop
    execute format('alter view public.%I set (security_invoker = false)', v);
    execute format('revoke all on public.%I from public', v);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on public.%I from anon', v);
      execute format('grant select on public.%I to anon', v);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on public.%I from authenticated', v);
      execute format('grant select on public.%I to authenticated', v);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant select on public.%I to service_role', v);
    end if;
  end loop;
end $blk$;

-- ============================================================ function grants
-- The three writers are security definer: nobody but the service role (and the
-- owner, e.g. pg_cron) may call them. The helpers are pure and stay callable.
do $blk$
declare f text;
begin
  foreach f in array array['public.cfb_lab_ingest_quotes(jsonb)','public.cfb_lab_derive_lines(timestamptz)',
    'public.cfb_lab_set_role(text,text,text,text,text)','public.cfb_lab_game_kickoff(text)',
    'public.cfb_lab_game_quotes(text)','public.cfb_lab_append_only()','public.cfb_lab_predictions_guard()',
    'public.cfb_lab_lines_guard()','public.cfb_lab_results_guard()','public.cfb_lab_roles_guard()']
  loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function %s from anon', f);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on function %s from authenticated', f);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', f);
    end if;
  end loop;
end $blk$;

-- PostgREST caches the schema; this makes the tables, views and functions
-- visible to it without a restart. Fires after commit.
notify pgrst, 'reload schema';
