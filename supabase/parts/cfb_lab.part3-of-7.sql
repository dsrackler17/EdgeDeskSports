-- cfb_lab -- part 3 of 7.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- ============================================================ append-only
create or replace function public.cfb_lab_append_only()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $fn$
begin
  if tg_op = 'UPDATE' then
    raise exception '% is append-only: rows are never updated (a correction is a new row with supersedes)', tg_table_name
      using errcode = 'restrict_violation';
  elsif tg_op = 'DELETE' then
    raise exception '% is append-only: rows are never deleted', tg_table_name
      using errcode = 'restrict_violation';
  else
    raise exception '% is append-only: it is never truncated', tg_table_name
      using errcode = 'restrict_violation';
  end if;
end $fn$;

-- A LIVE prediction is taken by the lab before kickoff, now: it cannot be
-- dated in the future. (Every row-local rule is a named check constraint on
-- the table; this is the one that needs the clock.)
create or replace function public.cfb_lab_predictions_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $fn$
begin
  if new.origin = 'LIVE' and new.prediction_ts > now() + interval '10 minutes' then
    raise exception 'cfb_lab_predictions: LIVE prediction % is dated % which is in the future (now %)',
      new.prediction_id, new.prediction_ts, now()
      using errcode = 'check_violation';
  end if;
  return new;
end $fn$;

-- The quotes of one game: rows written with its game_id, plus rows written
-- before their provider event was mapped (game_id NULL) whose NEWEST map row
-- (per source + provider_event_id) now names the game. The same resolution
-- cfb_lab_ingest_quotes applies at write time, applied again at read time, so
-- an Odds API event's earliest quotes still count once the event is mapped.
create or replace function public.cfb_lab_game_quotes(p_game_id text)
returns setof public.cfb_lab_market_quotes language sql stable
set search_path = pg_catalog, pg_temp
as $fn$
  select q.* from public.cfb_lab_market_quotes q where q.game_id = p_game_id
  union all
  select q.* from public.cfb_lab_market_quotes q
    join (
      select distinct on (m.source, m.provider_event_id) m.source, m.provider_event_id, m.game_id
        from public.cfb_lab_event_map m
       where (m.source, m.provider_event_id) in
             (select m2.source, m2.provider_event_id from public.cfb_lab_event_map m2 where m2.game_id = p_game_id)
       order by m.source, m.provider_event_id, m.created_at desc, m.recorded_at desc, m.map_id desc
    ) cur on cur.game_id = p_game_id and q.source = cur.source and q.provider_event_id = cur.provider_event_id
   where q.game_id is null
$fn$;

-- The kickoff the lab knows for a game: the newest of what the predictions
-- (by prediction_ts) and the game's quotes (cfb_lab_game_quotes, by
-- observed_at) say. A tie takes the later kickoff. NULL when the game is unknown.
create or replace function public.cfb_lab_game_kickoff(p_game_id text)
returns timestamptz language sql stable
set search_path = pg_catalog, pg_temp
as $fn$
  select k from (
    select p.kickoff_ts as k, p.prediction_ts as seen
      from public.cfb_lab_predictions p where p.game_id = p_game_id
    union all
    select q.kickoff_ts, q.observed_at
      from public.cfb_lab_game_quotes(p_game_id) q where q.kickoff_ts is not null
  ) x
  order by seen desc, k desc
  limit 1
$fn$;

-- A CLOSE line is derived at least three hours after kickoff, so late quote
-- syncs land first (METRICS.md §4). The kickoff is the later of the row's own
-- kickoff_ts and cfb_lab_game_kickoff(); the check is skipped when both are NULL.
create or replace function public.cfb_lab_lines_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $fn$
declare k timestamptz;
begin
  if new.kind = 'CLOSE' then
    -- the later of the kickoff the row carries and the one the lab knows
    k := greatest(new.kickoff_ts, public.cfb_lab_game_kickoff(new.game_id));
    if k is not null and new.derived_at < k + interval '3 hours' then
      raise exception 'cfb_lab_market_lines: CLOSE % for game % derived at %, before kickoff % + 3 hours',
        new.line_id, new.game_id, new.derived_at, k
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $fn$;

-- A correction names an earlier result of the SAME game.
create or replace function public.cfb_lab_results_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $fn$
begin
  if new.supersedes is not null and not exists (
       select 1 from public.cfb_lab_results r
        where r.result_id = new.supersedes and r.game_id = new.game_id) then
    raise exception 'cfb_lab_results: % supersedes %, which is not an existing result of game %',
      new.result_id, new.supersedes, new.game_id
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end $fn$;

-- One champion. A champion event is refused while another model's current
-- role is champion: demote it first (cfb_lab_set_role does both, in order).
create or replace function public.cfb_lab_roles_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $fn$
declare other text;
begin
  if new.role = 'champion' then
    select c.model_version into other from (
      select distinct on (r.model_version) r.model_version, r.role
        from public.cfb_lab_model_roles r
       where r.model_version <> new.model_version
       order by r.model_version, r.effective_at desc, r.recorded_at desc, r.event_id desc
    ) c where c.role = 'champion' limit 1;
    if other is not null then
      raise exception 'cfb_lab_model_roles: % cannot become champion while % is champion; demote it first',
        new.model_version, other
        using errcode = 'unique_violation';
    end if;
  end if;
  return new;
end $fn$;

drop trigger if exists cfb_lab_predictions_guard_trg on public.cfb_lab_predictions;
create trigger cfb_lab_predictions_guard_trg before insert on public.cfb_lab_predictions
  for each row execute function public.cfb_lab_predictions_guard();
drop trigger if exists cfb_lab_market_lines_guard_trg on public.cfb_lab_market_lines;
create trigger cfb_lab_market_lines_guard_trg before insert on public.cfb_lab_market_lines
  for each row execute function public.cfb_lab_lines_guard();
drop trigger if exists cfb_lab_results_guard_trg on public.cfb_lab_results;
create trigger cfb_lab_results_guard_trg before insert on public.cfb_lab_results
  for each row execute function public.cfb_lab_results_guard();
drop trigger if exists cfb_lab_model_roles_guard_trg on public.cfb_lab_model_roles;
create trigger cfb_lab_model_roles_guard_trg before insert on public.cfb_lab_model_roles
  for each row execute function public.cfb_lab_roles_guard();

-- Append-only triggers, row level security, the authenticated read policy and
-- the grants, on every table. anon gets nothing on any table; authenticated
-- reads; the service role inserts and reads (and cannot update, delete or
-- truncate even before the triggers are reached).
do $blk$
declare
  t text;
begin
  foreach t in array array['cfb_lab_predictions','cfb_lab_market_quotes','cfb_lab_market_lines',
    'cfb_lab_event_map','cfb_lab_results','cfb_lab_evaluations','cfb_lab_miss_reviews',
    'cfb_lab_model_roles','cfb_lab_experiments','cfb_lab_audit_log','cfb_lab_partitions',
    'cfb_lab_research_queue','cfb_lab_reports']
  loop
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
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on table public.%I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke insert, update, delete, truncate, references, trigger on table public.%I from authenticated', t);
      execute format('grant select on table public.%I to authenticated', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke update, delete, truncate on table public.%I from service_role', t);
      execute format('grant select, insert on table public.%I to service_role', t);
    end if;
  end loop;
end $blk$;

-- ====================================================== quote de-duplication
-- A lenient timestamp parse, used only to order an incoming batch.
create or replace function public.cfb_lab_try_ts(p text)
returns timestamptz language plpgsql stable
set search_path = pg_catalog, pg_temp
as $fn$
begin
  return p::timestamptz;
exception when others then
  return null;
end $fn$;
