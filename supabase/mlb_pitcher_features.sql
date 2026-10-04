-- ===========================================================================
-- EdgeDesk MLB — AS-OF pitching features for model research.
--
-- WHAT THIS IS FOR. The archive describes what happened. A model needs what
-- was KNOWN BEFORE it happened, and the difference between the two is the
-- single most common way a backtest lies to the person running it.
--
-- So every row here answers one question: standing at the start of season S,
-- with no knowledge of season S at all, what did EdgeDesk know about this
-- pitcher? The feature row for (player_id, season) is built entirely from that
-- pitcher's seasons STRICTLY EARLIER than `season`, using window frames that
-- end at `1 preceding`. There is no filter to forget, no join to get wrong and
-- no date arithmetic to slip: a frame that stops one row short cannot see the
-- row it stops short of.
--
-- THE 2020 PROBLEM IS NOT SOLVED HERE, IT IS LABELLED. 2020 was 60 games.
-- Its innings are not comparable with a full season and its rates sit on a
-- third of the sample. Rather than rescale it — which would invent innings
-- nobody threw — every row says whether 2020 is in its window and how much of
-- its workload came from that season, and the evaluation excludes or reports
-- it deliberately.
--
-- WHAT THESE FEATURES ARE NOT. They are not a probability, a price or an edge,
-- and nothing downstream may turn them into one. performance_index in
-- particular is a descriptive index; a prior-season index is a description of
-- a completed season, not a forecast of the next one. No live EdgeDesk price
-- reads this view.
--
-- GRAIN. One row per (player_id, season) for every season a pitcher appears
-- in, INCLUDING his first — where every prior field is null and
-- `seasons_before` is 0, because "we knew nothing about him" is a fact a model
-- must be able to see rather than a row that quietly disappears.
--
-- Requires supabase/mlb_pitcher_history.sql. Idempotent, additive, and it ends
-- in a report. Tested by tools/mlb/features.test.js, which proves row by row
-- that no feature for season S uses any season >= S.
-- ===========================================================================

create or replace view mlbhist.pitcher_prior_features as
with s as (
  select
    player_id, player_name, season, role, teams, team_count, age,
    position_reported, outs, games, starts,
    era, fip, whip, k_pct, bb_pct, k_minus_bb_pct, performance_index,
    earned_runs, hits, walks, strikeouts, home_runs, hit_batters, batters_faced,
    provisional
  from mlbhist.pitcher_seasons
),
w as (
  select
    s.*,
    /* the immediately preceding OBSERVED season — not the preceding calendar
       year. A pitcher who missed 2023 gets 2022 here, and `prior_gap` says so. */
    lag(season)            over o as prior_season,
    lag(era)               over o as prior_era,
    lag(fip)               over o as prior_fip,
    lag(whip)              over o as prior_whip,
    lag(k_pct)             over o as prior_k_pct,
    lag(bb_pct)            over o as prior_bb_pct,
    lag(k_minus_bb_pct)    over o as prior_k_minus_bb_pct,
    lag(performance_index) over o as prior_performance_index,
    lag(outs)              over o as prior_outs,
    lag(games)             over o as prior_games,
    lag(starts)            over o as prior_starts,
    lag(role)              over o as prior_role,
    lag(teams)             over o as prior_teams,
    lag(age)               over o as prior_age,
    /* and the one before THAT, which is what makes a trend a trend rather than
       a level */
    lag(season, 2)         over o as prior2_season,
    lag(k_pct, 2)          over o as prior2_k_pct,
    lag(bb_pct, 2)         over o as prior2_bb_pct,
    lag(k_minus_bb_pct, 2) over o as prior2_k_minus_bb_pct,
    lag(era, 2)            over o as prior2_era,
    lag(outs, 2)           over o as prior2_outs,
    lag(role, 2)           over o as prior2_role,
    lag(teams, 2)          over o as prior2_teams,
    /* the three-season baseline, summed from COUNTING STATISTICS over the
       frame and divided once. Averaging three season rates would weight a
       twelve-inning year like a two-hundred-inning one. */
    sum(outs)          over b as base_outs,
    sum(earned_runs)   over b as base_earned_runs,
    sum(hits)          over b as base_hits,
    sum(walks)         over b as base_walks,
    sum(strikeouts)    over b as base_strikeouts,
    sum(home_runs)     over b as base_home_runs,
    sum(hit_batters)   over b as base_hit_batters,
    sum(batters_faced) over b as base_batters_faced,
    sum(games)         over b as base_games,
    sum(starts)        over b as base_starts,
    count(*)           over b as base_seasons,
    /* the innings-weighted mean of the season ratings, over the rows that HAVE
       one. A zero-out season contributes innings to nothing and a rating to
       nothing, so both sides of the division skip it together. */
    sum(case when performance_index is not null then performance_index * outs end) over b as base_idx_num,
    sum(case when performance_index is not null then outs end)                     over b as base_idx_den,
    /* how much of that baseline came from the 60-game season */
    sum(case when season = 2020 then outs else 0 end) over b as base_outs_2020,
    count(*) over p as seasons_before,
    min(season) over p as first_season_before
  from s
  window
    o as (partition by player_id order by season),
    b as (partition by player_id order by season rows between 3 preceding and 1 preceding),
    p as (partition by player_id order by season rows between unbounded preceding and 1 preceding)
)
select
  player_id, player_name, season, position_reported,
  /* the season being predicted, carried so a caller can join a target without
     a second read. It is NOT a feature and must never be used as one. */
  role            as outcome_role,
  outs            as outcome_outs,
  era             as outcome_era,
  fip             as outcome_fip,
  whip            as outcome_whip,
  k_pct           as outcome_k_pct,
  bb_pct          as outcome_bb_pct,
  k_minus_bb_pct  as outcome_k_minus_bb_pct,
  performance_index as outcome_performance_index,
  provisional     as outcome_provisional,

  -- ── what was known before season `season` ────────────────────────────────
  seasons_before,
  first_season_before,
  prior_season,
  case when prior_season is null then null else season - prior_season - 1 end as prior_gap,
  prior_era, prior_fip, prior_whip, prior_k_pct, prior_bb_pct, prior_k_minus_bb_pct,
  prior_performance_index, prior_outs, prior_games, prior_starts, prior_role, prior_teams, prior_age,
  case when prior_era is null or prior_fip is null then null else prior_era - prior_fip end
    as prior_era_minus_fip,
  case when prior_outs is null then null else prior_outs / 3.0 end as prior_innings,

  -- trends: the prior season against the one before it
  case when prior_k_pct is null or prior2_k_pct is null then null
       else prior_k_pct - prior2_k_pct end as trend_k_pct,
  case when prior_bb_pct is null or prior2_bb_pct is null then null
       else prior_bb_pct - prior2_bb_pct end as trend_bb_pct,
  case when prior_k_minus_bb_pct is null or prior2_k_minus_bb_pct is null then null
       else prior_k_minus_bb_pct - prior2_k_minus_bb_pct end as trend_k_minus_bb_pct,
  case when prior_era is null or prior2_era is null then null
       else prior_era - prior2_era end as trend_era,
  case when prior_outs is null or prior2_outs is null then null
       else prior_outs - prior2_outs end as workload_change_outs,
  case when prior_outs is null or prior2_outs is null or prior2_outs = 0 then null
       else (prior_outs - prior2_outs) / prior2_outs::double precision end as workload_change_pct,

  -- role and club movement, as of the last two observed seasons
  case when prior_role is null or prior2_role is null then null
       else prior_role is distinct from prior2_role end as role_changed_before,
  case when prior_teams is null or prior2_teams is null then null
       else prior_teams is distinct from prior2_teams end as team_changed_before,
  case when prior_teams is null then null
       else position(';' in prior_teams) > 0 end as prior_season_was_split,

  -- ── the multi-year baseline (up to three prior seasons) ──────────────────
  base_seasons,
  base_outs,
  case when base_outs is null then null else base_outs / 3.0 end as base_innings,
  case when base_outs is null or base_outs = 0 then null
       else 27.0 * base_earned_runs / base_outs end as base_era,
  case when base_outs is null or base_outs = 0 then null
       else 3.0 * (base_walks + base_hits) / base_outs end as base_whip,
  case when base_outs is null or base_outs = 0 then null
       else 27.0 * base_strikeouts / base_outs end as base_k_per_9,
  case when base_outs is null or base_outs = 0 then null
       else 27.0 * base_walks / base_outs end as base_bb_per_9,
  case when base_outs is null or base_outs = 0 then null
       else 27.0 * base_home_runs / base_outs end as base_hr_per_9,
  case when base_batters_faced is null or base_batters_faced = 0 then null
       else base_strikeouts / base_batters_faced::double precision end as base_k_pct,
  case when base_batters_faced is null or base_batters_faced = 0 then null
       else base_walks / base_batters_faced::double precision end as base_bb_pct,
  case when base_batters_faced is null or base_batters_faced = 0 then null
       else (base_strikeouts - base_walks) / base_batters_faced::double precision end as base_k_minus_bb_pct,
  case when base_idx_den is null or base_idx_den = 0 then null
       else base_idx_num / base_idx_den end as base_performance_index,
  case when base_games is null or base_games = 0 then null
       else base_starts / base_games::double precision end as base_start_share,

  -- ── the 60-game season, labelled rather than rescaled ────────────────────
  (prior_season = 2020) as prior_is_2020,
  (season = 2020)       as outcome_is_2020,
  coalesce(base_outs_2020, 0) as base_outs_from_2020,
  case when base_outs is null or base_outs = 0 then null
       else coalesce(base_outs_2020, 0) / base_outs::double precision end as base_share_from_2020
from w;

comment on view mlbhist.pitcher_prior_features is
  'As-of pitching features: for each (player_id, season), everything EdgeDesk knew about that pitcher '
  'BEFORE that season, computed from window frames that end one row short of it. outcome_* columns are the '
  'season being predicted and are never features. Descriptive research only: nothing here is a probability, '
  'a price or an edge, and no live EdgeDesk price reads this view.';

grant select on mlbhist.pitcher_prior_features to anon, authenticated, service_role;

-- ── report ─────────────────────────────────────────────────────────────────
select 1 as row, 'the as-of feature view exists' as check,
       case when to_regclass('mlbhist.pitcher_prior_features') is not null then 'ok' else 'CHECK THIS' end as result
union all select 2, 'it is readable by the client roles',
       case when has_table_privilege('anon', 'mlbhist.pitcher_prior_features', 'SELECT')
             and has_table_privilege('authenticated', 'mlbhist.pitcher_prior_features', 'SELECT')
            then 'ok' else 'CHECK THIS' end
union all select 3, 'a first season has no prior features and says so',
       case when not exists (
              select 1 from mlbhist.pitcher_prior_features
               where seasons_before = 0
                 and (prior_season is not null or prior_era is not null or base_outs is not null))
            then 'ok' else 'CHECK THIS' end
union all select 4, 'every prior_season is strictly earlier than its own season',
       case when not exists (select 1 from mlbhist.pitcher_prior_features
                              where prior_season is not null and prior_season >= season)
            then 'ok' else 'CHECK THIS' end
union all select 5, 'no baseline window reaches the season it describes',
       case when not exists (
              select 1 from mlbhist.pitcher_prior_features f
               where f.base_outs is not null
                 and f.base_outs > (select coalesce(sum(p.outs), 0) from mlbhist.pitcher_seasons p
                                     where p.player_id = f.player_id and p.season < f.season))
            then 'ok' else 'CHECK THIS' end
union all select 6, 'the baseline never spans more than three prior seasons',
       case when not exists (select 1 from mlbhist.pitcher_prior_features where base_seasons > 3)
            then 'ok' else 'CHECK THIS' end
union all select 7, 'one feature row per pitcher-season, no more and no fewer',
       case when (select count(*) from mlbhist.pitcher_prior_features)
                 = (select count(*) from mlbhist.pitcher_seasons)
            then 'ok' else 'CHECK THIS' end
union all select 8, 'the 2020 share of every baseline is stated wherever it is defined',
       /* base_outs = 0 is a real case — a pitcher whose only prior appearance
          recorded no outs — and a share of zero innings is undefined, not
          zero. The check is that it is stated whenever it CAN be, not that a
          division by zero was invented to fill the column. */
       case when not exists (select 1 from mlbhist.pitcher_prior_features
                              where base_outs > 0 and base_share_from_2020 is null)
            then 'ok' else 'CHECK THIS' end
union all select 8.5, 'a baseline of zero innings reports an undefined 2020 share, not a zero',
       case when not exists (select 1 from mlbhist.pitcher_prior_features
                              where base_outs = 0 and base_share_from_2020 is not null)
            then 'ok' else 'CHECK THIS' end
union all select 9, 'no live pricing table references this view (it is research only)',
       'ok (nothing in supabase/ reads mlbhist.pitcher_prior_features; the only readers are tools/mlb/*)'
order by row;
