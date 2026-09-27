-- cfb_decision -- part 2 of 2.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.
-- This last part prints the report: every row should read ok.

-- Shadow comparison: the current and the challenger engine on the same game and book.
create or replace view public.cfb_decision_shadow_compare as
select c.game_id, c.book, c.decided_at,
       c.engine_version as current_engine, c.status as current_status, c.probability_edge as current_edge,
       x.engine_version as challenger_engine, x.status as challenger_status, x.probability_edge as challenger_edge,
       (c.status is distinct from x.status) as status_differs
  from public.cfb_decision_snapshots c
  join public.cfb_decision_snapshots x
    on x.game_id = c.game_id and coalesce(x.book, '') = coalesce(c.book, '') and x.decided_at = c.decided_at
   and x.engine_role = 'CHALLENGER'
 where c.engine_role = 'CURRENT';

-- The scorecard (brief section 73) per engine version and status, graded decisions only.
create or replace view public.cfb_decision_scorecard as
select d.engine_version, d.status,
       count(*)                                   as decisions,
       avg(d.probability_edge)                    as avg_probability_edge,
       avg(d.empirical_ev)                        as avg_ev,
       avg(r.clv_pts)                             as avg_clv_pts,
       avg(case when r.positive_clv then 1.0 else 0.0 end) as positive_clv_rate,
       sum(case when r.ats_result = 'W' then 1 else 0 end)  as wins,
       sum(case when r.ats_result = 'L' then 1 else 0 end)  as losses,
       sum(case when r.ats_result = 'P' then 1 else 0 end)  as pushes,
       sum(r.units)                               as units,
       sum(r.units) / nullif(sum(case when r.ats_result in ('W','L') then 1 else 0 end), 0) as roi_per_decision
  from public.cfb_decision_snapshots d
  join public.cfb_decision_results r on r.decision_id = d.decision_id
 group by d.engine_version, d.status;

do $blk$
declare
  v text;
begin
  foreach v in array array['cfb_decision_lab_view','cfb_decision_shadow_compare','cfb_decision_scorecard']
  loop
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('grant select on public.%I to authenticated', v);
    end if;
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on public.%I from anon', v);
    end if;
  end loop;
end $blk$;

notify pgrst, 'reload schema';

-- ================================================================= report
with tables(t) as (
  values ('cfb_decision_model_versions'),('cfb_probability_calibration'),('cfb_ev_calibration'),
         ('cfb_decision_policies'),('cfb_bankroll_policy'),('cfb_decision_snapshots'),('cfb_bet_eligibility'),
         ('cfb_portfolio_exposure'),('cfb_decision_results'),('cfb_decision_experiments'),('cfb_manual_decisions')
)
select check_name, status from (
  select 1 as ord, 'table ' || t || ': exists, append-only, row level security' as check_name,
         case when to_regclass('public.' || t) is not null
               and (select count(*) from pg_trigger tg where tg.tgrelid = to_regclass('public.' || t)
                     and tg.tgname in (t || '_no_update_trg', t || '_no_delete_trg', t || '_no_truncate_trg')) = 3
               and (select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.' || t))
              then 'ok' else 'CHECK THIS' end as status
    from tables
  union all
  select 2, 'keys: one decision per game x book x moment x engine x policy; one result per decision; holdout once',
         case when to_regclass('public.cfb_decision_snapshots_key') is not null
               and to_regclass('public.cfb_decision_results_key') is not null
               and to_regclass('public.cfb_decision_experiments_holdout_once') is not null then 'ok' else 'CHECK THIS' end
  union all
  select 3, 'Model Lab views: decision panel, shadow comparison, scorecard',
         case when to_regclass('public.cfb_decision_lab_view') is not null
               and to_regclass('public.cfb_decision_shadow_compare') is not null
               and to_regclass('public.cfb_decision_scorecard') is not null then 'ok' else 'CHECK THIS' end
) r
order by ord, check_name;

