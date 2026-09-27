-- cfb_market_integrity -- part 2 of 2.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.
-- This last part prints the report: every row should read ok.

-- --------------------------------------------------- 5. settlement safety
-- A FINAL needs a valid final score: two integers in 0..150, not tied. The
-- lab's JS applies the same rule before writing (integrity.finalProblem); this
-- makes the database refuse a bad row even from another writer.
create or replace function public.cfb_market_results_safety()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $fn$
begin
  if new.status = 'FINAL' then
    if new.home_points is null or new.away_points is null
       or new.home_points < 0 or new.away_points < 0 or new.home_points > 150 or new.away_points > 150 then
      raise exception 'cfb_lab_results: FINAL % needs two scores in 0..150 (got % - %)', new.game_id, new.home_points, new.away_points
        using errcode = 'check_violation';
    end if;
    if new.home_points = new.away_points then
      raise exception 'cfb_lab_results: FINAL % is tied % - %: college football has no ties (a placeholder or a feed fault)', new.game_id, new.home_points, new.away_points
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $fn$;
drop trigger if exists cfb_market_results_safety_trg on public.cfb_lab_results;
create trigger cfb_market_results_safety_trg before insert on public.cfb_lab_results
  for each row execute function public.cfb_market_results_safety();

-- A wager is graded once per (prediction, eval version, result, close line):
-- the evaluation id already hashes exactly these, and this index makes the
-- database say so too. Created only when the table has no duplicate (so a bad
-- history is reported, never hidden by a failed migration).
do $blk$
begin
  if to_regclass('public.cfb_lab_evaluations_graded_once') is null then
    if not exists (
      select 1 from public.cfb_lab_evaluations
       group by prediction_id, eval_version, coalesce(result_id, ''), coalesce(close_line_id, '') having count(*) > 1) then
      execute 'create unique index cfb_lab_evaluations_graded_once on public.cfb_lab_evaluations '
           || '(prediction_id, eval_version, coalesce(result_id, ''''), coalesce(close_line_id, ''''))';
    else
      raise notice 'cfb_lab_evaluations has duplicate gradings: cfb_lab_evaluations_graded_once NOT created (see the report)';
    end if;
  end if;
end $blk$;

-- -------------------------------------------- 6. guarded admin: model roles
-- One accidental click must not change the champion. Everything
-- cfb_lab_set_role checks, plus: the model version typed twice (p_confirm),
-- a model already registered (a new model enters as candidate, with a label),
-- a reason of at least 10 characters, an actor that names a person or a job,
-- and never a direct retirement of the champion (promote another first).
create or replace function public.cfb_market_admin_set_role(p_model text, p_label text, p_role text, p_reason text, p_actor text, p_confirm text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_cur record;
begin
  if coalesce(p_model, '') = '' or p_model !~ '^[a-z0-9_.:-]{3,80}$' then
    raise exception 'cfb_market_admin_set_role: model_version must be 3-80 characters of [a-z0-9_.:-]' using errcode = 'invalid_parameter_value';
  end if;
  if p_confirm is distinct from p_model then
    raise exception 'cfb_market_admin_set_role: p_confirm must repeat the model version exactly (explicit version selection)' using errcode = 'invalid_parameter_value';
  end if;
  if p_role is null or p_role not in ('champion','challenger','candidate','retired') then
    raise exception 'cfb_market_admin_set_role: role must be champion, challenger, candidate or retired' using errcode = 'invalid_parameter_value';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'cfb_market_admin_set_role: a reason of at least 10 characters is required' using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(p_actor, '') !~ '^[A-Za-z0-9 _.@:-]{2,64}$' then
    raise exception 'cfb_market_admin_set_role: an actor (2-64 characters) is required' using errcode = 'invalid_parameter_value';
  end if;
  select distinct on (r.model_version) r.* into v_cur from public.cfb_lab_model_roles r
   where r.model_version = p_model order by r.model_version, r.effective_at desc, r.recorded_at desc, r.event_id desc;
  if not found and p_role <> 'candidate' then
    raise exception 'cfb_market_admin_set_role: % is not registered; register it as a candidate first', p_model using errcode = 'invalid_parameter_value';
  end if;
  if not found and coalesce(p_label, '') = '' then
    raise exception 'cfb_market_admin_set_role: a new model needs a label' using errcode = 'invalid_parameter_value';
  end if;
  if found and v_cur.role = 'champion' and p_role = 'retired' then
    raise exception 'cfb_market_admin_set_role: the champion cannot be retired directly; promote another model first' using errcode = 'invalid_parameter_value';
  end if;
  if found and v_cur.role = 'retired' and p_role = 'champion' then
    raise exception 'cfb_market_admin_set_role: a retired model cannot be promoted directly; make it a challenger first' using errcode = 'invalid_parameter_value';
  end if;
  return public.cfb_lab_set_role(p_model, p_label, p_role, btrim(p_reason), btrim(p_actor));
end $fn$;

-- ------------------------------------------------ 7. BET-volume anomaly
-- Official (LIVE T24) BET snapshots per model and week, against the median of
-- that model's earlier weeks. flag = more than 3x the history median and above
-- 10 (or above 20 with fewer than 3 earlier weeks). Review, never cancel.
create or replace view public.cfb_market_bet_volume with (security_invoker = true) as
with w as (
  select model_version, season, week, count(*) filter (where decision_class = 'BET') as bets, count(*) as official
    from public.cfb_lab_predictions
   where origin = 'LIVE' and checkpoint_type = 'T24'
   group by model_version, season, week
), h as (
  select a.model_version, a.season, a.week, a.bets, a.official,
         (select percentile_cont(0.5) within group (order by b.bets) from w b
           where b.model_version = a.model_version and (b.season, b.week) < (a.season, a.week)) as history_median,
         (select count(*) from w b where b.model_version = a.model_version and (b.season, b.week) < (a.season, a.week)) as history_weeks
    from w a
)
select model_version, season, week, bets, official, history_median, history_weeks,
       case when history_weeks >= 3 then greatest(10, 3 * greatest(history_median, 1)) else 20 end as bet_limit,
       bets > case when history_weeks >= 3 then greatest(10, 3 * greatest(history_median, 1)) else 20 end as flag
  from h;

-- ---------------------------------------------- append-only, RLS, grants
do $blk$
declare
  t text;
  f text;
begin
  foreach t in array array['cfb_market_quote_quarantine','cfb_market_line_corrections'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_no_update_trg', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.cfb_lab_append_only()', t || '_no_update_trg', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_delete_trg', t);
    execute format('create trigger %I before delete on public.%I for each row execute function public.cfb_lab_append_only()', t || '_no_delete_trg', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate_trg', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.cfb_lab_append_only()', t || '_no_truncate_trg', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_read', t);
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on table public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke insert, update, delete, truncate, references, trigger on table public.%I from authenticated', t);
      execute format('grant select on table public.%I to authenticated', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke update, delete, truncate on table public.%I from service_role', t);
      execute format('grant select, insert on table public.%I to service_role', t);
    end if;
  end loop;
  execute 'revoke all on public.cfb_market_bet_volume from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on public.cfb_market_bet_volume from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant select on public.cfb_market_bet_volume to authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant select on public.cfb_market_bet_volume to service_role'; end if;
  foreach f in array array['public.cfb_market_quarantine_quotes(jsonb,text,timestamptz)', 'public.cfb_market_ingest_quotes(jsonb)',
                           'public.cfb_market_admin_set_role(text,text,text,text,text,text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $blk$;

-- PostgREST picks up the new RPCs and tables
notify pgrst, 'reload schema';

-- ================================================================== report
with roles as (
  select exists (select 1 from pg_roles where rolname = 'anon') as has_anon,
         exists (select 1 from pg_roles where rolname = 'authenticated') as has_auth
)
select ord, check_name, status from (
  select 1 as ord, 'cfb_lab.sql applied first (cfb_lab_h, cfb_lab_ingest_quotes, cfb_lab_results)' as check_name,
         case when to_regprocedure('public.cfb_lab_ingest_quotes(jsonb)') is not null and to_regclass('public.cfb_lab_results') is not null
              then 'ok' else 'CHECK THIS' end as status
  union all
  select 2, 'tables: cfb_market_quote_quarantine, cfb_market_line_corrections (append-only)',
         case when to_regclass('public.cfb_market_quote_quarantine') is not null and to_regclass('public.cfb_market_line_corrections') is not null
               and (select count(*) from pg_trigger where not tgisinternal and tgrelid in (to_regclass('public.cfb_market_quote_quarantine'), to_regclass('public.cfb_market_line_corrections'))
                      and tgname like '%\_no\_%' escape '\') = 6
              then 'ok' else 'CHECK THIS' end
  union all
  select 3, 'quote rules self-check: +450 spread, American 0, a future timestamp, a clean -3.5 at -110/-110',
         case when public.cfb_market_quote_problems('{"market_type":"spread","home_line":450}'::jsonb, now()) = array['SPREAD_OUT_OF_BOUNDS']
               and public.cfb_market_quote_problems('{"market_type":"moneyline","price_home":0,"price_away":-150}'::jsonb, now()) = array['PRICE_ZERO']
               and 'OBSERVED_IN_FUTURE' = any(public.cfb_market_quote_problems(jsonb_build_object('market_type','spread','home_line',-3,'observed_at', (now() + interval '1 hour')::text), now()))
               and cardinality(public.cfb_market_quote_problems('{"market_type":"spread","home_line":-3.5,"price_home":-110,"price_away":-110}'::jsonb, now())) = 0
              then 'ok' else 'CHECK THIS' end
  union all
  select 4, 'a missing field is never 0: null / "" / "abc" are not numbers',
         case when public.cfb_market_strict_num('null'::jsonb) is null and public.cfb_market_strict_num('""'::jsonb) is null
               and public.cfb_market_strict_num('"abc"'::jsonb) is null and public.cfb_market_strict_num('"-3.5"'::jsonb) = -3.5
              then 'ok' else 'CHECK THIS' end
  union all
  select 5, 'settlement: FINAL needs two scores in 0..150 that are not tied (trigger on cfb_lab_results)',
         case when exists (select 1 from pg_trigger where tgname = 'cfb_market_results_safety_trg' and tgrelid = to_regclass('public.cfb_lab_results'))
              then 'ok' else 'CHECK THIS' end
  union all
  select 6, 'a wager is graded once: unique (prediction, eval version, result, close line)',
         case when to_regclass('public.cfb_lab_evaluations_graded_once') is not null then 'ok' else 'CHECK THIS' end
  union all
  select 7, 'writer and admin functions are not callable by anon or authenticated',
         case when not (select has_anon and has_auth from roles) then 'CHECK THIS'
              when not exists (
                select 1 from unnest(array['public.cfb_market_quarantine_quotes(jsonb,text,timestamptz)','public.cfb_market_ingest_quotes(jsonb)',
                                           'public.cfb_market_admin_set_role(text,text,text,text,text,text)']) f, unnest(array['anon','authenticated']) r
                 where coalesce(has_function_privilege(r, to_regprocedure(f), 'execute'), true))
              then 'ok' else 'CHECK THIS' end
  union all
  select 8, 'anon reads no integrity table or view; authenticated reads and writes none',
         case when not (select has_anon and has_auth from roles) then 'CHECK THIS'
              when not exists (select 1 from unnest(array['cfb_market_quote_quarantine','cfb_market_line_corrections','cfb_market_bet_volume']) t
                                where coalesce(has_table_privilege('anon', to_regclass('public.' || t), 'select'), true)
                                   or not coalesce(has_table_privilege('authenticated', to_regclass('public.' || t), 'select'), false))
               and not exists (select 1 from unnest(array['cfb_market_quote_quarantine','cfb_market_line_corrections']) t
                                where coalesce(has_table_privilege('authenticated', to_regclass('public.' || t), 'insert,update,delete,truncate'), true))
              then 'ok' else 'CHECK THIS' end
) x
order by ord, check_name;

