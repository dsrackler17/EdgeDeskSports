-- portfolio_decision -- part 8 of 9.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- ─────────────────────────────────────────────────────────────────────────────
-- 16. THE OPERATOR'S MOAT METRICS — counts over readers, never a reader.
--     Any figure drawn from fewer than 5 readers is withheld. Not exposed to
--     analytics; nothing here leaves the database except through this call.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.portfolio_admin_moat_metrics(p_days int default 30)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare since timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 365))); out jsonb; users int;
  k_min int := 5;
begin
  if not public.portfolio_is_admin() then raise exception 'portfolio: operators only' using errcode = '42501'; end if;
  select count(distinct user_id) into users from public.portfolio_positions where placed_at >= since;
  with pos as (
    select p.id, p.user_id, p.status, j.decision_recorded_at, j.closing_source, j.would_repeat,
           (s.position_id is not null) as has_snap,
           (s.edgedesk ? 'probability' or s.edgedesk ? 'fair_odds_decimal' or s.edgedesk ? 'fair_line') as snap_model,
           (s.market ? 'odds_decimal' or s.market ? 'price') as snap_market, s.origin,
           (j.decision_recorded_at is not null and j.decision_recorded_at < least(coalesce(p.event_start_at, 'infinity'::timestamptz), coalesce(p.settled_at, 'infinity'::timestamptz))) as decision_pre
      from public.portfolio_positions p
      left join public.portfolio_journal_entries j on j.position_id = p.id
      left join public.portfolio_decision_snapshots s on s.position_id = p.id
     where p.placed_at >= since),
  per_user as (select p0.user_id, count(*) filter (where z.has_snap or z.decision_pre) as ctx from public.portfolio_positions p0
                 left join public.portfolio_journal_entries j0 on j0.position_id = p0.id
                 left join public.portfolio_decision_snapshots s0 on s0.position_id = p0.id
                 cross join lateral (select s0.position_id is not null as has_snap,
                   (j0.decision_recorded_at is not null and j0.decision_recorded_at < least(coalesce(p0.event_start_at, 'infinity'::timestamptz), coalesce(p0.settled_at, 'infinity'::timestamptz))) as decision_pre) z
                group by p0.user_id)
  select jsonb_build_object(
    'window_days', p_days, 'readers_with_positions', case when users >= k_min then users end,
    'withheld_below_readers', k_min,
    'positions', case when users >= k_min then (select count(*) from pos) end,
    'share_with_decision_snapshot', case when users >= k_min then (select round(avg(case when has_snap then 1 else 0 end), 4) from pos) end,
    'share_with_pre_event_context', case when users >= k_min then (select round(avg(case when has_snap or decision_pre then 1 else 0 end), 4) from pos) end,
    'share_full_snapshot', case when users >= k_min then (select round(avg(case when has_snap and snap_model and snap_market then 1 else 0 end), 4) from pos) end,
    'share_settled_with_close', case when users >= k_min then (select round(avg(case when closing_source is not null then 1 else 0 end), 4) from pos where status <> 'OPEN') end,
    'share_settled_reviewed', case when users >= k_min then (select round(avg(case when would_repeat is not null then 1 else 0 end), 4) from pos where status <> 'OPEN') end,
    'snapshots_by_origin', case when users >= k_min then (select coalesce(jsonb_object_agg(origin, n), '{}'::jsonb) from (select origin, count(*) as n from pos where has_snap group by origin) o) end,
    'path_points_per_snapshot', case when users >= k_min then (select round(avg(n), 2) from (select count(m.id) as n from public.portfolio_decision_snapshots s
        left join public.portfolio_market_path m on m.position_id = s.position_id where s.recorded_at >= since group by s.position_id) q) end,
    'card_entries_recorded_share', case when (select count(distinct user_id) from public.portfolio_card_events where at >= since) >= k_min then
        (select round(count(*) filter (where event = 'RECORDED')::numeric / nullif(count(*) filter (where event = 'ADDED'), 0), 4)
           from public.portfolio_card_events where at >= since) end,
    'experiments_concluded', case when users >= k_min then (select count(*) from public.portfolio_experiments where concluded_at >= since) end,
    'readers_by_context_depth', (select jsonb_build_object(
        'at_least_10', case when count(*) filter (where ctx >= 10) >= k_min then count(*) filter (where ctx >= 10) end,
        'at_least_30', case when count(*) filter (where ctx >= 30) >= k_min then count(*) filter (where ctx >= 30) end,
        'at_least_100', case when count(*) filter (where ctx >= 100) >= k_min then count(*) filter (where ctx >= 100) end) from per_user),
    'generated_at', now()) into out;
  return out;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 17. ROW LEVEL SECURITY AND GRANTS
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.portfolio_methodology enable row level security;
alter table public.portfolio_decision_snapshots enable row level security;
alter table public.portfolio_market_path enable row level security;
alter table public.portfolio_reflections enable row level security;
alter table public.portfolio_outcome_classes enable row level security;
alter table public.portfolio_baselines enable row level security;
alter table public.portfolio_insights enable row level security;
alter table public.portfolio_insight_observations enable row level security;
alter table public.portfolio_card_events enable row level security;

-- the methodology is published method, not anyone's data
drop policy if exists portfolio_methodology_read on public.portfolio_methodology;
create policy portfolio_methodology_read on public.portfolio_methodology for select to authenticated using (true);

drop policy if exists portfolio_snapshots_select_own on public.portfolio_decision_snapshots;
create policy portfolio_snapshots_select_own on public.portfolio_decision_snapshots for select to authenticated using (user_id = auth.uid());
drop policy if exists portfolio_snapshots_insert_own on public.portfolio_decision_snapshots;
create policy portfolio_snapshots_insert_own on public.portfolio_decision_snapshots for insert to authenticated with check (user_id = auth.uid());
-- no update policy and no delete policy: a snapshot goes only with its position
drop policy if exists portfolio_path_select_own on public.portfolio_market_path;
create policy portfolio_path_select_own on public.portfolio_market_path for select to authenticated using (user_id = auth.uid());
drop policy if exists portfolio_reflections_select_own on public.portfolio_reflections;
create policy portfolio_reflections_select_own on public.portfolio_reflections for select to authenticated using (user_id = auth.uid());
drop policy if exists portfolio_outcome_select_own on public.portfolio_outcome_classes;
create policy portfolio_outcome_select_own on public.portfolio_outcome_classes for select to authenticated using (user_id = auth.uid());
drop policy if exists portfolio_outcome_insert_own on public.portfolio_outcome_classes;
create policy portfolio_outcome_insert_own on public.portfolio_outcome_classes for insert to authenticated with check (user_id = auth.uid());
drop policy if exists portfolio_baselines_select_own on public.portfolio_baselines;
create policy portfolio_baselines_select_own on public.portfolio_baselines for select to authenticated using (user_id = auth.uid());
drop policy if exists portfolio_baselines_insert_own on public.portfolio_baselines;
create policy portfolio_baselines_insert_own on public.portfolio_baselines for insert to authenticated with check (user_id = auth.uid());
drop policy if exists portfolio_insights_select_own on public.portfolio_insights;
create policy portfolio_insights_select_own on public.portfolio_insights for select to authenticated using (user_id = auth.uid());
drop policy if exists portfolio_insights_insert_own on public.portfolio_insights;
create policy portfolio_insights_insert_own on public.portfolio_insights for insert to authenticated with check (user_id = auth.uid());
drop policy if exists portfolio_insight_obs_select_own on public.portfolio_insight_observations;
create policy portfolio_insight_obs_select_own on public.portfolio_insight_observations for select to authenticated using (user_id = auth.uid());
drop policy if exists portfolio_insight_obs_insert_own on public.portfolio_insight_observations;
create policy portfolio_insight_obs_insert_own on public.portfolio_insight_observations for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.portfolio_insights i where i.id = insight_id and i.user_id = auth.uid()));
drop policy if exists portfolio_card_events_select_own on public.portfolio_card_events;
create policy portfolio_card_events_select_own on public.portfolio_card_events for select to authenticated using (user_id = auth.uid());
drop policy if exists portfolio_card_events_insert_own on public.portfolio_card_events;
create policy portfolio_card_events_insert_own on public.portfolio_card_events for insert to authenticated with check (user_id = auth.uid());

revoke all on public.portfolio_methodology, public.portfolio_decision_snapshots, public.portfolio_market_path, public.portfolio_reflections,
  public.portfolio_outcome_classes, public.portfolio_baselines, public.portfolio_insights, public.portfolio_insight_observations,
  public.portfolio_card_events from anon, authenticated;
grant select on public.portfolio_methodology, public.portfolio_market_path, public.portfolio_reflections to authenticated;
grant select, insert on public.portfolio_decision_snapshots, public.portfolio_outcome_classes, public.portfolio_baselines,
  public.portfolio_insights, public.portfolio_insight_observations, public.portfolio_card_events to authenticated;
-- the experiment's reflection is the reader's one write after the fact
grant select, insert, update, delete on public.portfolio_methodology, public.portfolio_decision_snapshots, public.portfolio_market_path,
  public.portfolio_reflections, public.portfolio_outcome_classes, public.portfolio_baselines, public.portfolio_insights,
  public.portfolio_insight_observations, public.portfolio_card_events to service_role;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace s on s.oid = p.pronamespace
            where s.nspname = 'public' and p.proname in ('portfolio_methodology_guard', 'portfolio_methodology_current', 'portfolio_freshness',
              'portfolio_context_quality', 'portfolio_outcome_class', 'portfolio_edge_capture', 'portfolio_j_num', 'portfolio_j_text', 'portfolio_j_ts',
              'portfolio_j_american', 'portfolio_snapshot_edgedesk', 'portfolio_snapshot_market', 'portfolio_user_state', 'portfolio_snapshot_guard',
              'portfolio_snapshot_after', 'portfolio_path_guard', 'portfolio_path_from_snapshot', 'portfolio_path_from_journal',
              'portfolio_svc_attach_feed_path', 'portfolio_reflections_guard', 'portfolio_reflection_log', 'portfolio_context',
              'portfolio_writer_is', 'portfolio_outcome_guard', 'portfolio_classify_outcomes', 'portfolio_baseline_guard', 'portfolio_moments',
              'portfolio_baseline', 'portfolio_fact_key', 'portfolio_fact_in', 'portfolio_insight_guard', 'portfolio_observe_insight',
              'portfolio_insight_memory', 'portfolio_experiment_window', 'portfolio_experiments_record_guard', 'portfolio_experiment_evidence',
              'portfolio_conclude_experiment', 'portfolio_card_events_guard', 'portfolio_card_recorded', 'portfolio_decision_record',
              'portfolio_search', 'portfolio_settled_notice', 'portfolio_due_notices', 'portfolio_export', 'portfolio_delete_everything',
              'portfolio_admin_moat_metrics') loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('revoke all on function %s from anon', f.sig);
    if f.proname like 'portfolio\_svc\_%' then
      execute format('revoke all on function %s from authenticated', f.sig);
      execute format('grant execute on function %s to service_role', f.sig);
    else
      /* portfolio_path_from_snapshot and portfolio_card_recorded run as their
         owner when the snapshot's trigger calls them, and check inside that
         the position and the entry are the caller's own */
      execute format('grant execute on function %s to authenticated, service_role', f.sig);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
