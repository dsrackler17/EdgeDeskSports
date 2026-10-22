-- EdgeDesk: NFL referee flag tendencies
-- Tier: Observed (T0 counts from play-by-play). No model adjustment until CLV-tested.

create table if not exists nfl_ref_assignments (
  game_id     text primary key,          -- nflverse id, e.g. 2026_07_GB_DET
  season      int  not null,
  week        int  not null,
  referee     text not null,
  source      text not null default 'nflverse',  -- nflverse | footballzebras | manual
  updated_at  timestamptz not null default now()
);

create table if not exists nfl_ref_game_penalties (
  game_id                text primary key references nfl_ref_assignments(game_id),
  season                 int  not null,
  week                   int  not null,
  game_type              text not null,
  gameday                date,
  away_team              text not null,
  home_team              text not null,
  referee                text not null,
  total                  numeric,
  total_line             numeric,
  spread_line            numeric,
  result                 numeric,
  flags                  int  not null,   -- penalty plays in pbp (one per play)
  accepted_flags         int  not null,   -- excludes declined / offsetting
  penalty_yards          int  not null,
  home_flags             int  not null,
  away_flags             int  not null,
  off_holding            int  not null,
  def_holding            int  not null,
  dpi                    int  not null,
  opi                    int  not null,
  false_start            int  not null,
  roughing_passer        int  not null,
  unnecessary_roughness  int  not null,
  illegal_contact        int  not null,
  illegal_use_of_hands   int  not null,
  snaps                  int  not null,
  holding_total          int  not null,
  flags_per_100_snaps    numeric,
  went_over              int,             -- 1 over, 0 under, null push
  updated_at             timestamptz not null default now()
);

create index if not exists nfl_ref_gp_ref_season on nfl_ref_game_penalties (referee, season);

-- Per-ref averages for any season, compared to that season's league average
create or replace view nfl_ref_season_summary as
with lg as (
  select season,
         avg(flags)::numeric          as lg_flags_pg,
         avg(holding_total)::numeric  as lg_holding_pg
  from nfl_ref_game_penalties where game_type = 'REG' group by season
)
select g.season, g.referee,
       count(*)                                         as games,
       round(avg(g.flags), 2)                           as flags_pg,
       round(avg(g.penalty_yards), 2)                   as penalty_yards_pg,
       round(avg(g.holding_total), 2)                   as holding_pg,
       round(avg(g.off_holding), 2)                     as off_holding_pg,
       round(avg(g.def_holding), 2)                     as def_holding_pg,
       round(avg(g.dpi), 2)                             as dpi_pg,
       round(avg(g.false_start), 2)                     as false_start_pg,
       round(avg(g.home_flags - g.away_flags), 2)       as home_minus_away_pg,
       round(100.0 * sum(g.flags) / nullif(sum(g.snaps), 0), 2) as flags_per_100_snaps,
       round(avg(g.flags) - lg.lg_flags_pg, 2)          as flags_vs_league_pg,
       round(avg(g.holding_total) - lg.lg_holding_pg, 2) as holding_vs_league_pg,
       sum(g.went_over)                                 as overs,
       count(g.went_over) - sum(g.went_over)            as unders,
       rank() over (partition by g.season order by avg(g.flags) desc)         as flags_rank,
       rank() over (partition by g.season order by avg(g.holding_total) desc) as holding_rank
from nfl_ref_game_penalties g
join lg on lg.season = g.season
where g.game_type = 'REG'
group by g.season, g.referee, lg.lg_flags_pg, lg.lg_holding_pg;

-- Rolling 3-season baseline (current + prior two) — the stabler number
create or replace view nfl_ref_baseline_3yr as
with mx as (select max(season) s from nfl_ref_game_penalties),
w as (select g.* from nfl_ref_game_penalties g, mx where g.game_type = 'REG' and g.season > mx.s - 3),
lg as (select avg(flags)::numeric f, avg(holding_total)::numeric h from w)
select referee,
       count(*)                               as games,
       round(avg(flags), 2)                   as flags_pg,
       round(avg(holding_total), 2)           as holding_pg,
       round(avg(off_holding), 2)             as off_holding_pg,
       round(avg(dpi), 2)                     as dpi_pg,
       round(100.0 * sum(flags) / nullif(sum(snaps), 0), 2) as flags_per_100_snaps,
       round(avg(flags) - (select f from lg), 2)          as flags_vs_league_pg,
       round(avg(holding_total) - (select h from lg), 2)  as holding_vs_league_pg
from w group by referee;

-- What the game card reads: this week's ref + season + 3yr numbers
create or replace view nfl_game_ref_context as
select a.game_id, a.season, a.week, a.referee, a.source,
       s.games      as season_games,
       s.flags_pg   as season_flags_pg,
       s.holding_pg as season_holding_pg,
       s.off_holding_pg as season_off_holding_pg,
       s.flags_vs_league_pg   as season_flags_vs_league,
       s.holding_vs_league_pg as season_holding_vs_league,
       s.flags_rank, s.holding_rank,
       b.games      as y3_games,
       b.flags_pg   as y3_flags_pg,
       b.holding_pg as y3_holding_pg,
       b.flags_vs_league_pg   as y3_flags_vs_league,
       b.holding_vs_league_pg as y3_holding_vs_league
from nfl_ref_assignments a
left join nfl_ref_season_summary s on s.referee = a.referee and s.season = a.season
left join nfl_ref_baseline_3yr  b on b.referee = a.referee;

alter table nfl_ref_assignments    enable row level security;
alter table nfl_ref_game_penalties enable row level security;
create policy "read ref assignments" on nfl_ref_assignments    for select using (true);
create policy "read ref penalties"   on nfl_ref_game_penalties for select using (true);
