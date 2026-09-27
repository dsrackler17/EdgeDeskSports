-- cfb_lab -- part 4 of 7.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

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
