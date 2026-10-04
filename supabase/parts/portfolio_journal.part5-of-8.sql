-- portfolio_journal -- part 5 of 8.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- make sure the caller's cached facts are current; returns the zone used.
-- First build: everything. After that, only what changed: each cached row
-- remembers the position and journal versions it was built from, and the
-- rows to recompute are those whose sources moved, plus every position placed
-- in the days around them (whole local days, with a margin) — so a day's
-- exposure, a session and "after a result" stay exact without recomputing a
-- lifetime. A change to the rules, or to most of the history, rebuilds all.
create or replace function public.portfolio_facts_fresh(p_tz text)
returns text language plpgsql volatile set jit = off set work_mem = '64MB' as $$
declare
  z text := public.portfolio_tz(p_tz); u uuid := auth.uid(); st text; cur record; rs text;
  n int; total int; lo timestamptz; hi timestamptz; core_lo timestamptz; core_hi timestamptz; changed int; ids uuid[];
begin
  if u is null then return z; end if;
  st := public.portfolio_facts_stamp(u);
  select c.stamp into cur from public.portfolio_facts_cache_state c where c.user_id = u and c.tz = z;
  if cur.stamp is not distinct from st then return z; end if;
  /* one rebuild at a time per reader and zone; whoever waited re-checks */
  perform pg_advisory_xact_lock(hashtextextended('portfolio_facts|' || u::text || '|' || z, 0));
  select c.* into cur from public.portfolio_facts_cache_state c where c.user_id = u and c.tz = z;
  st := public.portfolio_facts_stamp(u);
  if cur.stamp is not distinct from st then return z; end if;
  rs := (select count(*) || ':' || coalesce(max(updated_at)::text, '-') from public.portfolio_rules where user_id = u);
  select count(*) into total from public.portfolio_positions where user_id = u;

  if cur.stamp is not null and cur.rules_stamp is not distinct from rs then
    /* what moved: new or edited positions and journals (their placed and
       settled times, old and new), and positions that are gone */
    select array_agg(distinct x.id), count(distinct x.id), min(x.at), max(x.at) into ids, changed, core_lo, core_hi from (
    select p.id, t.at from public.portfolio_positions p
      left join public.portfolio_journal_entries j on j.position_id = p.id
      left join public.portfolio_facts_cache c on c.user_id = u and c.tz = z and c.id = p.id
      cross join lateral (values (p.placed_at), (p.settled_at), (c.placed_at), (c.settled_at)) t(at)
     where p.user_id = u and t.at is not null
       and (c.id is null or c.src_position_at is distinct from p.updated_at or c.src_journal_at is distinct from j.updated_at)
    union all
    select c.id, t.at from public.portfolio_facts_cache c cross join lateral (values (c.placed_at), (c.settled_at)) t(at)
     where c.user_id = u and c.tz = z and t.at is not null
       and not exists (select 1 from public.portfolio_positions p where p.id = c.id)) x;
  end if;

  if cur.stamp is null or cur.rules_stamp is distinct from rs or changed is null or changed > greatest(500, total / 5) then
    delete from public.portfolio_facts_cache c where c.user_id = u and c.tz = z;
    insert into public.portfolio_facts_cache (user_id, tz, id, platform, platform_label, platform_type, position_type, sport, league, source, event_name, selection, status, result, placed_at, settled_at, event_start_at, placed_day, settled_day, event_day, placed_dow, event_dow, hour_band, lead_seconds, timing_bucket, stake_amt, pnl, ret, entry_dec, entry_price, odds_band, units, units_band, day_units, day_count, session_no, session_order, after_result, decision_source, decision_tags, planned, has_thesis, would_repeat, library, closing_source, model_pre_event, research_pre_event, clv_pct, clv_points, model_ev, price_slip, price_points, s_clv, s_model, s_price, s_sizing, s_timing, s_rules, s_market, process_weight, process_score, grade, rules_applicable, rules_followed, rules_broken, evidence, stake_type, src_position_at, src_journal_at)
    select u, z, f.id, f.platform, f.platform_label, f.platform_type, f.position_type, f.sport, f.league, f.source, f.event_name, f.selection, f.status, f.result, f.placed_at, f.settled_at, f.event_start_at, f.placed_day, f.settled_day, f.event_day, f.placed_dow, f.event_dow, f.hour_band, f.lead_seconds, f.timing_bucket, f.stake_amt, f.pnl, f.ret, f.entry_dec, f.entry_price, f.odds_band, f.units, f.units_band, f.day_units, f.day_count, f.session_no, f.session_order, f.after_result, f.decision_source, f.decision_tags, f.planned, f.has_thesis, f.would_repeat, f.library, f.closing_source, f.model_pre_event, f.research_pre_event, f.clv_pct, f.clv_points, f.model_ev, f.price_slip, f.price_points, f.s_clv, f.s_model, f.s_price, f.s_sizing, f.s_timing, f.s_rules, f.s_market, f.process_weight, f.process_score, f.grade, f.rules_applicable, f.rules_followed, f.rules_broken, f.evidence, f.stake_type, p.updated_at, j.updated_at
      from public.portfolio_facts(null, null, z, null) f
      join public.portfolio_positions p on p.id = f.id
      left join public.portfolio_journal_entries j on j.position_id = f.id;
  elsif changed > 0 then
    /* the core: whole local days from a day before the earliest change to two
       after the latest; computed with a further day either side */
    core_lo := ((date_trunc('day', core_lo at time zone z) - interval '1 day') at time zone z);
    core_hi := ((date_trunc('day', core_hi at time zone z) + interval '3 days') at time zone z);
    lo := ((date_trunc('day', core_lo at time zone z) - interval '1 day') at time zone z);
    hi := ((date_trunc('day', core_hi at time zone z) + interval '1 day') at time zone z);
    delete from public.portfolio_facts_cache c
     where c.user_id = u and c.tz = z
       and ((c.placed_at >= core_lo and c.placed_at < core_hi) or c.id = any (ids));
    insert into public.portfolio_facts_cache (user_id, tz, id, platform, platform_label, platform_type, position_type, sport, league, source, event_name, selection, status, result, placed_at, settled_at, event_start_at, placed_day, settled_day, event_day, placed_dow, event_dow, hour_band, lead_seconds, timing_bucket, stake_amt, pnl, ret, entry_dec, entry_price, odds_band, units, units_band, day_units, day_count, session_no, session_order, after_result, decision_source, decision_tags, planned, has_thesis, would_repeat, library, closing_source, model_pre_event, research_pre_event, clv_pct, clv_points, model_ev, price_slip, price_points, s_clv, s_model, s_price, s_sizing, s_timing, s_rules, s_market, process_weight, process_score, grade, rules_applicable, rules_followed, rules_broken, evidence, stake_type, src_position_at, src_journal_at)
    select u, z, f.id, f.platform, f.platform_label, f.platform_type, f.position_type, f.sport, f.league, f.source, f.event_name, f.selection, f.status, f.result, f.placed_at, f.settled_at, f.event_start_at, f.placed_day, f.settled_day, f.event_day, f.placed_dow, f.event_dow, f.hour_band, f.lead_seconds, f.timing_bucket, f.stake_amt, f.pnl, f.ret, f.entry_dec, f.entry_price, f.odds_band, f.units, f.units_band, f.day_units, f.day_count, f.session_no, f.session_order, f.after_result, f.decision_source, f.decision_tags, f.planned, f.has_thesis, f.would_repeat, f.library, f.closing_source, f.model_pre_event, f.research_pre_event, f.clv_pct, f.clv_points, f.model_ev, f.price_slip, f.price_points, f.s_clv, f.s_model, f.s_price, f.s_sizing, f.s_timing, f.s_rules, f.s_market, f.process_weight, f.process_score, f.grade, f.rules_applicable, f.rules_followed, f.rules_broken, f.evidence, f.stake_type, p.updated_at, j.updated_at
      from public.portfolio_facts(lo, hi, z, null) f
      join public.portfolio_positions p on p.id = f.id
      left join public.portfolio_journal_entries j on j.position_id = f.id
     where f.in_placed and f.placed_at >= core_lo and f.placed_at < core_hi
    on conflict (user_id, tz, id) do nothing;
  end if;
  select count(*) into n from public.portfolio_facts_cache c where c.user_id = u and c.tz = z;
  insert into public.portfolio_facts_cache_state (user_id, tz, stamp, built_at, rows, rules_stamp) values (u, z, st, now(), n, rs)
  on conflict (user_id, tz) do update set stamp = excluded.stamp, built_at = excluded.built_at, rows = excluded.rows, rules_stamp = excluded.rules_stamp;
  return z;
end $$;

-- the cached facts in the shape of portfolio_facts(), for one window
create or replace function public.portfolio_facts_cached(p_from timestamptz, p_to timestamptz, p_tz text, p_platform text default null)
returns table (id uuid, platform text, platform_label text, platform_type text, position_type text, sport text, league text, source text,
  event_name text, selection text, status text, result text, placed_at timestamptz, settled_at timestamptz, event_start_at timestamptz,
  in_placed boolean, in_settled boolean, in_event boolean, placed_day date, settled_day date, event_day date,
  placed_dow int, event_dow int, hour_band text,
  lead_seconds bigint, timing_bucket text, stake_amt numeric, pnl numeric, ret numeric, entry_dec numeric, entry_price numeric,
  odds_band text, units numeric, units_band text, day_units numeric, day_count int, session_no int, session_order int,
  after_result text, decile int, decision_source text, decision_tags text[], planned boolean, has_thesis boolean,
  would_repeat text, library text, closing_source text, model_pre_event boolean, research_pre_event boolean,
  clv_pct numeric, clv_points numeric, model_ev numeric, price_slip numeric, price_points numeric,
  s_clv numeric, s_model numeric, s_price numeric, s_sizing numeric, s_timing numeric, s_rules numeric, s_market numeric,
  process_weight int, process_score numeric, grade text, rules_applicable int, rules_followed int, rules_broken text[],
  evidence text, stake_type text)
language sql stable as $$
  with x as (
    select c.*,
           ((p_from is null or c.placed_at >= p_from) and (p_to is null or c.placed_at < p_to)) as in_placed_,
           (c.settled_at is not null and c.status <> 'OPEN' and (p_from is null or c.settled_at >= p_from) and (p_to is null or c.settled_at < p_to)) as in_settled_,
           (c.event_start_at is not null and (p_from is null or c.event_start_at >= p_from) and (p_to is null or c.event_start_at < p_to)) as in_event_
      from public.portfolio_facts_cache c
     where c.user_id = auth.uid() and c.tz = p_tz
       and (p_platform is null or c.platform = p_platform or ('type:' || c.platform_type) = p_platform)
       and (((p_from is null or c.placed_at >= p_from) and (p_to is null or c.placed_at < p_to))
        or (c.settled_at is not null and c.status <> 'OPEN' and (p_from is null or c.settled_at >= p_from) and (p_to is null or c.settled_at < p_to))
        or (c.event_start_at is not null and (p_from is null or c.event_start_at >= p_from) and (p_to is null or c.event_start_at < p_to))))
  select x.id, x.platform, x.platform_label, x.platform_type, x.position_type, x.sport, x.league, x.source, x.event_name, x.selection, x.status, x.result, x.placed_at, x.settled_at, x.event_start_at, x.in_placed_, x.in_settled_, x.in_event_, x.placed_day, x.settled_day, x.event_day, x.placed_dow, x.event_dow, x.hour_band, x.lead_seconds, x.timing_bucket, x.stake_amt, x.pnl, x.ret, x.entry_dec, x.entry_price, x.odds_band, x.units, x.units_band, x.day_units, x.day_count, x.session_no, x.session_order, x.after_result, case when x.in_placed_ then ntile(10) over (partition by x.in_placed_ order by x.placed_at, x.id) end, x.decision_source, x.decision_tags, x.planned, x.has_thesis, x.would_repeat, x.library, x.closing_source, x.model_pre_event, x.research_pre_event, x.clv_pct, x.clv_points, x.model_ev, x.price_slip, x.price_points, x.s_clv, x.s_model, x.s_price, x.s_sizing, x.s_timing, x.s_rules, x.s_market, x.process_weight, x.process_score, x.grade, x.rules_applicable, x.rules_followed, x.rules_broken, x.evidence, x.stake_type
    from x
$$;
