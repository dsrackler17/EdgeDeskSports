-- cfb_lab -- part 3 of 6.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

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

-- cfb_lab_quote_dedupe_v1 (METRICS.md §4). Takes a JSON array of quote objects
-- (the columns of cfb_lab_market_quotes; quote_id, fingerprint, is_heartbeat
-- and recorded_at are always computed here, whatever the caller sent) and
-- writes the ones the rule keeps. Returns
--   {received, written, duplicates, refused, rule_version, refusals:[{index, reason}]}.
--
-- Per quote, in observed_at order (ties in array order):
--   * game_id NULL -> resolved from cfb_lab_event_map (newest row per source +
--     provider_event_id), BEFORE the id is computed;
--   * key = (source, book, coalesce(game_id, provider_event_id), market_type);
--   * fingerprint = h(home_line, total_points, price_home, price_away, price_over, price_under);
--     quote_id = 'cfbq_' + h(source, book, key, market_type, observed_at) for an
--     ordinary quote, with a sixth part 'provider_open' / 'provider_close' for
--     a provider-declared row (so a declared number and an ordinary quote seen
--     at the same instant are two rows, not one id);
--   * REFUSED: unreadable; bad enum; no key; spread without home_line, total
--     without total_points, moneyline without a price; is_pregame not the
--     opposite of is_provider_close (in-play odds are never stored); both
--     provider flags; or, unless is_provider_close, observed_at >= kickoff_ts;
--   * provider-declared rows (is_provider_open or is_provider_close) are
--     stored at most once per key and flag -> otherwise DUPLICATE;
--   * an ordinary quote is WRITTEN when there is no earlier ordinary row for
--     the key, its fingerprint differs from the latest earlier one, that row
--     is >= 6 h older, or kickoff_ts - observed_at <= 3 h and that row is
--     >= 50 min older (the last two are heartbeats, is_heartbeat = true);
--     otherwise DUPLICATE. An existing quote_id is always DUPLICATE.
create or replace function public.cfb_lab_ingest_quotes(p_quotes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  c_rule     constant text := 'cfb_lab_quote_dedupe_v1';
  v_item     record;
  q          public.cfb_lab_market_quotes;
  v_key      text;
  v_reason   text;
  v_prev_at  timestamptz;
  v_prev_fp  text;
  v_write    boolean;
  v_hb       boolean;
  v_n        int;
  v_received int := 0;
  v_written  int := 0;
  v_dup      int := 0;
  v_refused  int := 0;
  v_refusals jsonb := '[]'::jsonb;
begin
  if p_quotes is null or jsonb_typeof(p_quotes) <> 'array' then
    raise exception 'cfb_lab_ingest_quotes: p_quotes must be a JSON array of quote objects'
      using errcode = 'invalid_parameter_value';
  end if;
  -- one writer at a time, so two overlapping syncs cannot both write a change
  perform pg_advisory_xact_lock(hashtext('cfb_lab_ingest_quotes'));

  for v_item in
    select e.value as j, e.ordinality as idx
      from jsonb_array_elements(p_quotes) with ordinality as e
     order by public.cfb_lab_try_ts(e.value ->> 'observed_at') nulls first, e.ordinality
  loop
    v_received := v_received + 1;
    v_reason := null;
    begin
      if jsonb_typeof(v_item.j) <> 'object' then
        raise exception 'not a JSON object';
      end if;
      q := jsonb_populate_record(null::public.cfb_lab_market_quotes, v_item.j);
    exception when others then
      v_reason := 'unreadable: ' || sqlerrm;
    end;

    if v_reason is null then
      q.is_provider_open  := coalesce(q.is_provider_open, false);
      q.is_provider_close := coalesce(q.is_provider_close, false);
      q.is_pregame        := coalesce(q.is_pregame, not q.is_provider_close);
      q.retrieved_at      := coalesce(q.retrieved_at, now());
      q.recorded_at       := now();
      if q.game_id is null and q.provider_event_id is not null then
        select m.game_id into q.game_id
          from public.cfb_lab_event_map m
         where m.source = q.source and m.provider_event_id = q.provider_event_id
         order by m.created_at desc, m.recorded_at desc, m.map_id desc
         limit 1;
      end if;
      v_key := coalesce(q.game_id, q.provider_event_id);

      if q.source is null or q.source not in ('espn','cfbd','odds_api','record') then
        v_reason := 'source must be one of espn, cfbd, odds_api, record';
      elsif coalesce(q.book, '') = '' then
        v_reason := 'book is required';
      elsif q.market_type is null or q.market_type not in ('spread','total','moneyline') then
        v_reason := 'market_type must be spread, total or moneyline';
      elsif q.observed_at is null then
        v_reason := 'observed_at is required';
      elsif v_key is null then
        v_reason := 'game_id or provider_event_id is required';
      elsif q.is_provider_open and q.is_provider_close then
        v_reason := 'a quote cannot be both a provider-declared open and a provider-declared close';
      elsif q.is_pregame = q.is_provider_close then
        v_reason := 'is_pregame must be false exactly for provider-declared closes (in-play odds are never stored)';
      elsif q.market_type = 'spread' and q.home_line is null then
        v_reason := 'a spread quote needs home_line';
      elsif q.market_type = 'total' and q.total_points is null then
        v_reason := 'a total quote needs total_points';
      elsif q.market_type = 'moneyline' and q.price_home is null and q.price_away is null then
        v_reason := 'a moneyline quote needs price_home or price_away';
      elsif not q.is_provider_close and q.kickoff_ts is not null and q.observed_at >= q.kickoff_ts then
        v_reason := 'observed at or after kickoff: never written as pregame';
      end if;
    end if;

    if v_reason is null then
      q.fingerprint := public.cfb_lab_h(
        public.cfb_lab_num(q.home_line), public.cfb_lab_num(q.total_points),
        public.cfb_lab_num(q.price_home), public.cfb_lab_num(q.price_away),
        public.cfb_lab_num(q.price_over), public.cfb_lab_num(q.price_under));
      q.quote_id := 'cfbq_' || case
        when q.is_provider_open then public.cfb_lab_h(q.source, q.book, v_key, q.market_type, public.cfb_lab_ts(q.observed_at), 'provider_open')
        when q.is_provider_close then public.cfb_lab_h(q.source, q.book, v_key, q.market_type, public.cfb_lab_ts(q.observed_at), 'provider_close')
        else public.cfb_lab_h(q.source, q.book, v_key, q.market_type, public.cfb_lab_ts(q.observed_at)) end;

      v_write := false;
      v_hb := false;
      if exists (select 1 from public.cfb_lab_market_quotes x where x.quote_id = q.quote_id) then
        v_write := false;
      elsif q.is_provider_open or q.is_provider_close then
        v_write := not exists (
          select 1 from public.cfb_lab_market_quotes x
           where x.source = q.source and x.book = q.book
             and coalesce(x.game_id, x.provider_event_id) = v_key
             and x.market_type = q.market_type
             and x.is_provider_open = q.is_provider_open
             and x.is_provider_close = q.is_provider_close);
      else
        v_prev_at := null;
        v_prev_fp := null;
        select x.observed_at, x.fingerprint into v_prev_at, v_prev_fp
          from public.cfb_lab_market_quotes x
         where x.source = q.source and x.book = q.book
           and coalesce(x.game_id, x.provider_event_id) = v_key
           and x.market_type = q.market_type
           and not x.is_provider_open and not x.is_provider_close
           and x.observed_at < q.observed_at
         order by x.observed_at desc, x.quote_id desc
         limit 1;
        if v_prev_at is null then
          v_write := true;
        elsif v_prev_fp is distinct from q.fingerprint then
          v_write := true;
        elsif q.observed_at - v_prev_at >= interval '6 hours' then
          v_write := true; v_hb := true;
        elsif q.kickoff_ts is not null and q.kickoff_ts - q.observed_at <= interval '3 hours'
              and q.observed_at - v_prev_at >= interval '50 minutes' then
          v_write := true; v_hb := true;
        end if;
      end if;

      if v_write then
        q.is_heartbeat := v_hb;
        begin
          insert into public.cfb_lab_market_quotes values (q.*) on conflict do nothing;
          get diagnostics v_n = row_count;
          if v_n = 1 then v_written := v_written + 1; else v_dup := v_dup + 1; end if;
        exception when others then
          v_reason := 'insert refused: ' || sqlerrm;
        end;
      else
        v_dup := v_dup + 1;
      end if;
    end if;

    if v_reason is not null then
      v_refused := v_refused + 1;
      if jsonb_array_length(v_refusals) < 100 then
        v_refusals := v_refusals || jsonb_build_array(jsonb_build_object('index', v_item.idx - 1, 'reason', v_reason));
      end if;
    end if;
  end loop;

  return jsonb_build_object('received', v_received, 'written', v_written, 'duplicates', v_dup,
    'refused', v_refused, 'rule_version', c_rule, 'refusals', v_refusals);
end $fn$;
