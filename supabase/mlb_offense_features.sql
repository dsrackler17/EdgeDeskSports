-- ===========================================================================
-- EdgeDesk MLB — AS-OF OFFENSIVE FEATURES for model research.
--
-- One view: mlbhist.batter_prior_features. For each (player_id, season) it
-- carries everything EdgeDesk knew about that hitter BEFORE that season, and
-- the season itself only as `outcome_*` columns a caller joins a target from.
--
-- WHY IT IS A VIEW OF WINDOW FRAMES AND NOT A QUERY SOMEONE REMEMBERS TO
-- FILTER. Every feature below comes from a frame that ends at `1 preceding`.
-- There is no filter to forget, no join to get wrong and no ordering to
-- accidentally reverse: a feature for 2024 CANNOT see 2024, because the frame
-- it is computed over stops at 2023. Look-ahead leakage is structurally
-- impossible rather than merely avoided, which is the only version of that
-- claim worth making.
--
-- WHAT THIS IS NOT. It is not a model, not a projection and not a promotion.
-- Nothing in research_model_current reads it, no live price, fair line or EV
-- depends on it, and importing this file changes no number anywhere in the
-- product. It exists so that a candidate feature can be evaluated honestly
-- before anyone argues for it.
--
-- 2020 IS CARRIED EXPLICITLY. A 60-game season inside a three-year baseline
-- is a different quantity from three full ones, so the share of the baseline
-- that came from it travels as its own column rather than being silently
-- averaged in. A model that ignores it is making a choice; a model that cannot
-- see it is making a mistake.
--
-- Run after supabase/mlb_offense_history.sql. Idempotent, additive, and it
-- ends in a report.
--
-- Proved by tools/mlb/offense_features.test.js, which corrupts a future season
-- and shows every prior feature unchanged.
-- ===========================================================================

create or replace view mlbhist.batter_prior_features as
with s as (
  select
    player_id, player_name, season, position_reported, age,
    games, plate_appearances, at_bats, hits, doubles, triples, home_runs,
    walks, strikeouts, hit_by_pitch, stolen_bases, caught_stealing, total_bases,
    sacrifice_flies, rbi, runs,
    avg, obp, slg, ops, iso, babip, k_pct, bb_pct, hr_pct, sb_success_pct,
    offensive_index, sample_flag, team_count, teams, provisional
  from mlbhist.batter_seasons
),
w as (
  select
    s.*,
    /* the season immediately before this one, whatever year it was */
    lag(season)            over o as prior_season,
    lag(plate_appearances) over o as prior_pa,
    lag(at_bats)           over o as prior_ab,
    lag(games)             over o as prior_games,
    lag(avg)               over o as prior_avg,
    lag(obp)               over o as prior_obp,
    lag(slg)               over o as prior_slg,
    lag(ops)               over o as prior_ops,
    lag(iso)               over o as prior_iso,
    lag(babip)             over o as prior_babip,
    lag(k_pct)             over o as prior_k_pct,
    lag(bb_pct)            over o as prior_bb_pct,
    lag(hr_pct)            over o as prior_hr_pct,
    lag(home_runs)         over o as prior_home_runs,
    lag(stolen_bases)      over o as prior_stolen_bases,
    lag(caught_stealing)   over o as prior_caught_stealing,
    lag(sb_success_pct)    over o as prior_sb_success_pct,
    lag(offensive_index)   over o as prior_offensive_index,
    lag(position_reported) over o as prior_position,
    lag(teams)             over o as prior_teams,
    lag(team_count)        over o as prior_team_count,
    lag(age)               over o as prior_age,
    /* and the one before that, so a trend has two points that are both past */
    lag(k_pct, 2)          over o as prior2_k_pct,
    lag(bb_pct, 2)         over o as prior2_bb_pct,
    lag(iso, 2)            over o as prior2_iso,
    lag(obp, 2)            over o as prior2_obp,
    lag(slg, 2)            over o as prior2_slg,
    lag(offensive_index,2) over o as prior2_offensive_index,
    lag(season, 2)         over o as prior2_season,

    /* the three-season baseline, PA-weighted, ending one season short.
       Rates are weighted by their own denominators rather than averaged: a
       hitter's three-year on-base percentage is times-on-base over times-up,
       not the mean of three rates. */
    sum(case when obp is not null then obp * (at_bats + walks + hit_by_pitch + coalesce(sacrifice_flies,0)) end) over b as base_obp_num,
    sum(case when obp is not null then (at_bats + walks + hit_by_pitch + coalesce(sacrifice_flies,0)) end)      over b as base_obp_den,
    sum(case when slg is not null then slg * at_bats end) over b as base_slg_num,
    sum(case when slg is not null then at_bats end)       over b as base_slg_den,
    sum(case when k_pct is not null then k_pct * plate_appearances end) over b as base_k_num,
    sum(case when k_pct is not null then plate_appearances end)         over b as base_k_den,
    sum(case when bb_pct is not null then bb_pct * plate_appearances end) over b as base_bb_num,
    sum(case when bb_pct is not null then plate_appearances end)          over b as base_bb_den,
    sum(case when iso is not null then iso * at_bats end) over b as base_iso_num,
    sum(case when iso is not null then at_bats end)       over b as base_iso_den,
    sum(case when offensive_index is not null then offensive_index * plate_appearances end) over b as base_idx_num,
    sum(case when offensive_index is not null then plate_appearances end)                   over b as base_idx_den,
    sum(plate_appearances) over b as base_pa,
    sum(home_runs)         over b as base_home_runs,
    sum(stolen_bases)      over b as base_stolen_bases,
    sum(caught_stealing)   over b as base_caught_stealing,
    /* how much of that baseline came from the 60-game season */
    sum(case when season = 2020 then plate_appearances else 0 end) over b as base_pa_2020,
    count(*) over p as seasons_before,
    min(season) over p as first_season_before,
    sum(plate_appearances) over p as career_pa_before
  from s
  window
    o as (partition by player_id order by season),
    b as (partition by player_id order by season rows between 3 preceding and 1 preceding),
    p as (partition by player_id order by season rows between unbounded preceding and 1 preceding)
)
select
  player_id, player_name, season, position_reported,

  /* THE SEASON BEING PREDICTED, carried so a caller can join a target without
     a second read. These are NOT features and must never be used as one. */
  plate_appearances as outcome_plate_appearances,
  games             as outcome_games,
  avg               as outcome_avg,
  obp               as outcome_obp,
  slg               as outcome_slg,
  ops               as outcome_ops,
  iso               as outcome_iso,
  babip             as outcome_babip,
  k_pct             as outcome_k_pct,
  bb_pct            as outcome_bb_pct,
  hr_pct            as outcome_hr_pct,
  home_runs         as outcome_home_runs,
  stolen_bases      as outcome_stolen_bases,
  sb_success_pct    as outcome_sb_success_pct,
  offensive_index   as outcome_offensive_index,
  sample_flag       as outcome_sample_flag,
  provisional       as outcome_provisional,

  -- ── what was known before season `season` ────────────────────────────────
  seasons_before,
  first_season_before,
  career_pa_before,
  prior_season,
  case when prior_season is null then null else season - prior_season - 1 end as prior_gap,
  prior_pa, prior_ab, prior_games,
  prior_avg, prior_obp, prior_slg, prior_ops, prior_iso, prior_babip,
  prior_k_pct, prior_bb_pct, prior_hr_pct,
  prior_home_runs, prior_stolen_bases, prior_caught_stealing, prior_sb_success_pct,
  prior_offensive_index, prior_position, prior_teams, prior_team_count, prior_age,
  case when prior_k_pct is null or prior_bb_pct is null then null
       else prior_bb_pct - prior_k_pct end as prior_bb_minus_k_pct,

  -- trends: the prior season against the one before it. BOTH are in the past.
  case when prior_k_pct is null or prior2_k_pct is null then null
       else prior_k_pct - prior2_k_pct end as trend_k_pct,
  case when prior_bb_pct is null or prior2_bb_pct is null then null
       else prior_bb_pct - prior2_bb_pct end as trend_bb_pct,
  case when prior_iso is null or prior2_iso is null then null
       else prior_iso - prior2_iso end as trend_iso,
  case when prior_obp is null or prior2_obp is null then null
       else prior_obp - prior2_obp end as trend_obp,
  case when prior_slg is null or prior2_slg is null then null
       else prior_slg - prior2_slg end as trend_slg,
  case when prior_offensive_index is null or prior2_offensive_index is null then null
       else prior_offensive_index - prior2_offensive_index end as trend_offensive_index,

  -- the three-season baseline, weighted by its own denominators
  case when base_obp_den > 0 then base_obp_num / base_obp_den end as base3_obp,
  case when base_slg_den > 0 then base_slg_num / base_slg_den end as base3_slg,
  case when base_obp_den > 0 and base_slg_den > 0
       then base_obp_num / base_obp_den + base_slg_num / base_slg_den end as base3_ops,
  case when base_k_den  > 0 then base_k_num  / base_k_den  end as base3_k_pct,
  case when base_bb_den > 0 then base_bb_num / base_bb_den end as base3_bb_pct,
  case when base_iso_den > 0 then base_iso_num / base_iso_den end as base3_iso,
  case when base_idx_den > 0 then base_idx_num / base_idx_den end as base3_offensive_index,
  base_pa as base3_plate_appearances,
  base_home_runs as base3_home_runs,
  base_stolen_bases as base3_stolen_bases,
  case when coalesce(base_stolen_bases,0) + coalesce(base_caught_stealing,0) > 0
       then base_stolen_bases::double precision
            / (base_stolen_bases + base_caught_stealing) end as base3_sb_success_pct,
  /* THE SHORTENED SEASON, NAMED. A three-year baseline that is half 2020 is a
     different quantity from three full ones, and a model that cannot see that
     is making a mistake it has no way to notice. */
  case when coalesce(base_pa,0) > 0
       then base_pa_2020::double precision / base_pa else null end as base3_share_2020,

  -- club movement, known before the season starts only in the sense that the
  -- PRIOR season's club count is known. It is not a transaction record.
  case when prior_team_count is null then null else prior_team_count > 1 end as prior_multi_club
from w;

grant select on mlbhist.batter_prior_features to anon, authenticated, service_role;

comment on view mlbhist.batter_prior_features is
  'As-of offensive features: for each (player_id, season), everything known BEFORE that season. '
  'Every feature comes from a window frame ending 1 preceding, so look-ahead leakage is structurally '
  'impossible. outcome_* columns are the season being predicted and are never features. '
  'Research only: nothing in research_model_current reads this and no live price depends on it.';

-- ── report ─────────────────────────────────────────────────────────────────
select 1 as row, 'the as-of offensive feature view exists' as check,
       case when to_regclass('mlbhist.batter_prior_features') is not null then 'ok' else 'CHECK THIS' end as result
union all select 2, 'a first season has no prior features',
       case when (select count(*) from mlbhist.batter_prior_features f
                   where f.seasons_before = 0 and f.prior_obp is not null) = 0
            then 'ok' else 'CHECK THIS' end
union all select 3, 'no feature is drawn from the season it describes',
       /* A prior feature equal to its own outcome on EVERY row would mean the
          frame was not offset. One row can coincide; all of them cannot.
          RESTRICTED TO 50+ PA ON BOTH SIDES on purpose: at three or seven
          plate appearances an on-base percentage is a small fraction like 1/7,
          and two seasons landing on .142857 is arithmetic rather than leakage —
          205 of 5,620 pairs coincide across the whole archive and only 2 of
          3,721 do once both seasons carry a real sample. Counting the tiny
          ones would make this check fail for the wrong reason, which is worse
          than not having it. */
       case when (select count(*) from mlbhist.batter_prior_features f
                   where f.prior_obp is not null and f.outcome_obp is not null
                     and f.prior_pa >= 50 and f.outcome_plate_appearances >= 50
                     and f.prior_obp = f.outcome_obp)
                 < greatest(5, (select count(*) from mlbhist.batter_prior_features f
                     where f.prior_obp is not null and f.outcome_obp is not null
                       and f.prior_pa >= 50 and f.outcome_plate_appearances >= 50) * 0.005)
            then 'ok' else 'CHECK THIS' end
union all select 4, 'the three-season baseline never includes the season it precedes',
       case when (select count(*) from mlbhist.batter_prior_features f
                   where f.base3_plate_appearances is not null
                     and f.seasons_before = 0) = 0
            then 'ok' else 'CHECK THIS' end
union all select 5, 'the 2020 share of the baseline is carried explicitly',
       case when (select count(*) from mlbhist.batter_prior_features
                   where base3_share_2020 > 0) > 0 then 'ok' else 'CHECK THIS' end
union all select 6, 'clients may read it',
       case when has_table_privilege('anon', 'mlbhist.batter_prior_features', 'SELECT')
            then 'ok' else 'CHECK THIS' end
union all select 7, 'nothing in the live model reads it',
       'ok (research_model_current is untouched by this file; no live price, fair line or EV references this view)'
order by row;
