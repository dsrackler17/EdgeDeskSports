-- Model Collective, migration 5: derived read models. Everything here is a
-- deterministic transform over the append-only tables (rules 8.7 to 8.10):
-- no view stores state, so every published number is reproducible.

-- Monogram fallback when a creator has no logo: first letters of the first
-- two words of the display name.
create or replace function collective.monogram(p_name text) returns text
language sql immutable as $$
  select upper(left(split_part(trim(p_name), ' ', 1), 1) ||
               left(split_part(trim(p_name), ' ', 2), 1))
$$;

-- Membership state is derived, never stored (rule 8.8): computed from live
-- submission recency against the in-season window of the creator's sports.
create or replace function collective.creator_membership(p_creator_id uuid) returns text
language plpgsql stable security definer set search_path = collective as $$
declare
  v_in_season boolean;
  v_last timestamptz;
  v_active_days int := collective.cfg_int('status.active_days', 10);
  v_inactive_days int := collective.cfg_int('status.inactive_days', 45);
begin
  select exists (
    select 1 from collective.models m
    join collective.sport_seasons ss on ss.sport_code = m.sport_code
    where m.creator_id = p_creator_id
      and current_date between ss.starts_on and ss.ends_on
  ) into v_in_season;

  select max(p.received_at) into v_last
  from collective.projections p
  join collective.models m on m.id = p.model_id
  where m.creator_id = p_creator_id
    and p.data_origin = 'live' and p.resolution_status = 'resolved';

  if v_last is null or not v_in_season then return 'MEMBER'; end if;
  if now() - v_last <= make_interval(days => v_active_days) then return 'ACTIVE CONTRIBUTOR'; end if;
  if now() - v_last >= make_interval(days => v_inactive_days) then return 'INACTIVE'; end if;
  return 'MEMBER';
end $$;

-- ---------------------------------------------------------------- reads

-- Newest resolved row per model per game, candidate or not.
create view collective.latest_projections as
select distinct on (p.model_id, p.game_id) p.*
from collective.projections p
where p.resolution_status = 'resolved'
order by p.model_id, p.game_id, p.received_at desc;

-- The graded numbers (rule 8.5): first pre-kickoff live submission each.
create view collective.first_submissions as
select p.* from collective.projections p where p.is_graded_candidate;

-- Every resolved row in receipt order: the movement trail.
create view collective.model_movement as
select p.model_id, p.game_id, p.id as projection_id, p.received_at, p.is_graded_candidate,
       p.is_late, p.data_origin, p.pick_side, p.projected_spread, p.projected_total,
       p.home_win_prob, p.line_at_submission
from collective.projections p
where p.resolution_status = 'resolved'
order by p.model_id, p.game_id, p.received_at;

-- Per-model record over graded candidates. Pushes are excluded from win
-- percentage (published grading rules). Null record = nothing graded yet.
create view collective.model_records as
select
  m.id as model_id,
  count(g.projection_id)                                   as graded,
  count(*) filter (where g.pick_result = 'win')            as wins,
  count(*) filter (where g.pick_result = 'loss')           as losses,
  count(*) filter (where g.pick_result = 'push')           as pushes,
  case when count(*) filter (where g.pick_result in ('win','loss')) > 0
       then round(count(*) filter (where g.pick_result = 'win')::numeric
                / count(*) filter (where g.pick_result in ('win','loss')), 4)
       end                                                 as win_pct,
  round(avg(g.margin_error), 2)                            as margin_mae,
  round(avg(g.total_error), 2)                             as total_mae,
  round(avg(g.brier), 4)                                   as brier
from collective.models m
join collective.grades g on g.model_id = m.id
group by m.id;

-- Slate coverage per model per week (rule 8.7): games available in the
-- sport-week versus games this model actually has a graded candidate on.
create view collective.model_coverage as
select
  m.id as model_id, g.season, g.week,
  count(distinct g.id)                                  as games_available,
  count(distinct fs.game_id)                            as games_submitted
from collective.models m
join collective.games g on g.sport_code = m.sport_code and g.week is not null
left join collective.first_submissions fs on fs.model_id = m.id and fs.game_id = g.id
group by m.id, g.season, g.week;

-- Season-to-date rollup: the slate that has actually become playable
-- (kickoff in the past) is the denominator.
create view collective.model_coverage_totals as
select
  m.id as model_id, g.season,
  count(distinct g.id)                       as games_available,
  count(distinct fs.game_id)                 as games_submitted,
  case when count(distinct g.id) > 0
       then round(100.0 * count(distinct fs.game_id) / count(distinct g.id), 1)
       else null end                         as coverage_pct
from collective.models m
join collective.games g on g.sport_code = m.sport_code and g.kickoff_at <= now()
left join collective.first_submissions fs on fs.model_id = m.id and fs.game_id = g.id
group by m.id, g.season;

-- Backfill stored and shown separately, never ranked (rule 9.4).
create view collective.model_backfill as
select p.model_id, count(*) as rows
from collective.projections p
where p.data_origin = 'backfill'
group by p.model_id;

-- One row per listed model of a listed, active creator: the wall.
create view collective.model_wall as
select
  c.id  as creator_id, c.slug as creator_slug, c.display_name as creator_name,
  c.logo_url, collective.monogram(c.display_name) as monogram,
  c.founding_member as founding, c.website_url, c.x_handle,
  collective.creator_membership(c.id) as membership,
  m.id as model_id, m.slug as model_slug, m.name as model_name, m.sport_code as sport,
  r.graded, r.wins, r.losses, r.pushes, r.win_pct, r.margin_mae, r.total_mae, r.brier,
  ct.coverage_pct,
  (select max(p.received_at) from collective.projections p
    where p.model_id = m.id and p.data_origin = 'live' and p.resolution_status = 'resolved')
    as last_submission_at
from collective.creators c
join collective.models m on m.creator_id = c.id and m.is_listed
left join collective.model_records r on r.model_id = m.id
left join collective.model_coverage_totals ct
  on ct.model_id = m.id
 and ct.season = (select max(season) from collective.sport_seasons ss where ss.sport_code = m.sport_code)
where c.is_listed and c.status = 'active';

-- Rankings: coverage-gated (rule 8.7), three metrics ranked separately and
-- never blended (rule 8.11). Below-threshold models come through with
-- is_ranked = false and a human-readable reason.
create view collective.model_rankings as
with cfg as (
  select collective.cfg_int('ranking.min_coverage_pct', 60) as min_cov,
         collective.cfg_int('ranking.min_graded_games', 20) as min_graded
), base as (
  select w.*, cfg.min_cov, cfg.min_graded,
         coalesce(w.coverage_pct, 0) >= cfg.min_cov
         and coalesce(w.graded, 0) >= cfg.min_graded as qualifies
  from collective.model_wall w cross join cfg
)
select
  b.creator_slug, b.creator_name, b.model_slug, b.model_name, b.sport,
  b.graded, b.coverage_pct, b.win_pct, b.margin_mae, b.brier,
  b.qualifies as is_ranked,
  case when b.qualifies then null
       when coalesce(b.graded, 0) < b.min_graded
         then format('%s graded games is below the %s minimum', coalesce(b.graded, 0), b.min_graded)
       else format('coverage %s%% is below the %s%% minimum', coalesce(b.coverage_pct, 0), b.min_cov)
  end as unranked_reason,
  case when b.qualifies and b.win_pct is not null
       then rank() over (partition by b.qualifies order by (case when b.qualifies then b.win_pct end) desc nulls last) end as rank_win_pct,
  case when b.qualifies and b.margin_mae is not null
       then rank() over (partition by b.qualifies order by (case when b.qualifies then b.margin_mae end) asc nulls last) end as rank_margin_mae,
  case when b.qualifies and b.brier is not null
       then rank() over (partition by b.qualifies order by (case when b.qualifies then b.brier end) asc nulls last) end as rank_brier
from base b;

-- Consensus (rule 8.9): a deterministic transform off first submissions
-- only, live origin only. Unweighted v1; a weighted version is a research
-- model and does not ship until it clears out-of-sample validation.
create view collective.consensus as
select
  fs.game_id,
  count(*)                                        as n,
  round(avg(fs.projected_spread), 2)              as spread_mean,
  round(percentile_cont(0.5) within group (order by fs.projected_spread)::numeric, 2) as spread_median,
  round(stddev_samp(fs.projected_spread), 2)      as spread_stdev,
  min(fs.projected_spread)                        as spread_min,
  max(fs.projected_spread)                        as spread_max,
  round(avg(fs.projected_total), 2)               as total_mean,
  round(percentile_cont(0.5) within group (order by fs.projected_total)::numeric, 2)  as total_median,
  round(avg(fs.home_win_prob), 4)                 as home_win_prob_mean,
  count(fs.pick_side)                             as n_picks,
  case when count(fs.pick_side) > 0
       then round(count(*) filter (where fs.pick_side = 'home')::numeric / count(fs.pick_side), 4)
       end                                        as pct_picks_home,
  case when count(fs.pick_side) > 0
       then round(greatest(count(*) filter (where fs.pick_side = 'home'),
                           count(*) filter (where fs.pick_side = 'away'))::numeric
                  / count(fs.pick_side), 4)
       end                                        as agreement
from collective.first_submissions fs
where fs.data_origin = 'live'
group by fs.game_id;

-- Unresolved rows quarantine visibly and never drop silently (rule 8.4).
create view collective.quarantine_queue as
select p.id as projection_id, c.slug as creator_slug, m.name as model_name,
       p.raw_game_ref, p.raw_row, p.quarantine_reason as reason,
       p.sport_code, p.season, p.received_at
from collective.projections p
join collective.models m on m.id = p.model_id
join collective.creators c on c.id = m.creator_id
where p.resolution_status = 'quarantined'
order by p.received_at desc;

-- Recent activity feed: submission events, no projection numbers.
create view collective.activity_feed as
select s.received_at as at, c.slug as creator_slug, c.display_name as creator_name,
       m.name as model_name, m.sport_code as sport, s.n_rows,
       (select count(*) from collective.projections p
         where p.submission_id = s.id and p.is_graded_candidate) as n_first,
       (select min(p.week) from collective.projections p where p.submission_id = s.id) as week
from collective.submissions s
join collective.models m on m.id = s.model_id
join collective.creators c on c.id = m.creator_id
where s.data_origin = 'live' and c.is_listed
order by s.received_at desc
limit 100;

-- Flat game rows with team codes, label, and result fields: the board's
-- spine, embeddable-free so PostgREST reads need no FK hints.
create view collective.game_detail as
select
  g.id as game_id, g.sport_code as sport, g.season, g.week, g.kickoff_at, g.status,
  ht.code as home, at_.code as away,
  at_.code || ' @ ' || ht.code as label,
  r.home_score, r.away_score, r.closing_spread, r.closing_total
from collective.games g
join collective.teams ht  on ht.id = g.home_team_id
join collective.teams at_ on at_.id = g.away_team_id
left join collective.results r on r.game_id = g.id;

-- Per-model rows for the board: graded candidates plus late rows (stored,
-- flagged, excluded from grading per rule 8.6 but shown honestly).
create view collective.board_models as
select
  p.game_id, p.model_id, c.slug as creator_slug, m.slug as model_slug,
  p.pick_side, p.projected_spread, p.projected_total, p.home_win_prob,
  p.received_at, p.is_late,
  gr.pick_result, gr.margin_error, gr.brier
from collective.projections p
join collective.models m on m.id = p.model_id and m.is_listed
join collective.creators c on c.id = m.creator_id and c.is_listed and c.status = 'active'
left join collective.grades gr on gr.projection_id = p.id
where p.resolution_status = 'resolved' and p.data_origin = 'live'
  and (p.is_graded_candidate or p.is_late);

-- Recent graded games per model, for the model detail page.
create view collective.model_game_log as
select
  p.model_id, p.game_id, gd.label, gd.kickoff_at, gd.week,
  p.pick_side, gd.closing_spread,
  case when gd.home_score is not null
       then gd.home_score::text || '-' || gd.away_score::text end as final,
  gr.pick_result, gr.margin_error, gr.brier, gr.graded_at,
  (select count(*) from collective.projections px
    where px.model_id = p.model_id and px.game_id = p.game_id
      and px.resolution_status = 'resolved') as movement_n
from collective.grades gr
join collective.projections p on p.id = gr.projection_id
join collective.game_detail gd on gd.game_id = gr.game_id;

grant select on collective.latest_projections, collective.first_submissions,
  collective.model_movement, collective.model_records, collective.model_coverage,
  collective.model_coverage_totals, collective.model_backfill, collective.model_wall,
  collective.model_rankings, collective.consensus, collective.quarantine_queue,
  collective.activity_feed, collective.game_detail, collective.board_models,
  collective.model_game_log to service_role;
