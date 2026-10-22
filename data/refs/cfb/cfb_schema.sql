-- EdgeDesk: CFB referee flag tendencies (FBS), 2024-2026
-- Tier: Observed. Display only.

create table if not exists cfb_ref_game_penalties (
  game_id               bigint primary key,      -- ESPN game id
  season                int not null,
  week                  int,
  start_date            timestamptz,
  neutral_site          boolean,
  home_team             text, away_team text,
  home_conference       text, away_conference text,
  home_points           int,  away_points int,
  referee_id            text,                    -- canonical name key; null = unknown
  referee               text,
  referee_primary_conf  text,
  referee_source        text,                    -- ncaa_listed | ncaa_matched_by_date_teams | espn
  referee_identity      text,                    -- inferred_crew_chief | espn_referee_role
  assignment_conflict   boolean default false,
  flags                 int,                     -- accepted, box score, both teams
  penalty_yards         int,
  home_flags            int, away_flags int,
  home_penalty_yards    int, away_penalty_yards int,
  holding_total         int,                     -- holding plays, not declined/offset
  off_holding           int, def_holding int, holding_side_unknown int,
  dpi                   int, opi int, false_start int,
  scrimmage_plays       int,
  flags_per_100_plays   numeric,
  pbp_available         boolean,
  source_url            text,
  updated_at            timestamptz not null default now()
);
create index if not exists cfb_ref_gp_ref on cfb_ref_game_penalties (referee_id, season);

-- Upcoming assignments (filled weekly from ESPN when published)
create table if not exists cfb_ref_assignments (
  game_id           bigint primary key,
  season            int not null,
  week              int,
  referee_id        text,
  referee           text,
  source            text not null,
  first_observed_at timestamptz not null default now()
);

create or replace view cfb_ref_season_summary as
with base as (select * from cfb_ref_game_penalties where referee_id is not null),
conf as (
  select season, home_conference conf, avg(flags)::numeric f, avg(holding_total)::numeric h
  from cfb_ref_game_penalties where home_conference = away_conference group by 1, 2
),
fbs as (select season, avg(flags)::numeric f, avg(holding_total)::numeric h from cfb_ref_game_penalties group by 1)
select b.season, b.referee_id, max(b.referee) referee, max(b.referee_primary_conf) primary_conf,
       count(*) games,
       round(avg(b.flags), 2) flags_pg,
       round(avg(b.penalty_yards), 2) penalty_yards_pg,
       round(avg(b.holding_total), 2) holding_pg,
       round(avg(b.off_holding), 2) off_holding_pg,
       round(avg(b.def_holding), 2) def_holding_pg,
       round(avg(b.dpi), 2) dpi_pg,
       round(avg(b.home_flags - b.away_flags), 2) home_minus_away_pg,
       round(100.0 * sum(b.flags) / nullif(sum(b.scrimmage_plays), 0), 2) flags_per_100_plays,
       round(avg(b.flags) - max(conf.f), 2) flags_vs_conf_pg,
       round(avg(b.holding_total) - max(conf.h), 2) holding_vs_conf_pg,
       round(avg(b.flags) - max(fbs.f), 2) flags_vs_fbs_pg,
       round(avg(b.holding_total) - max(fbs.h), 2) holding_vs_fbs_pg
from base b
join fbs on fbs.season = b.season
left join conf on conf.season = b.season and conf.conf = b.referee_primary_conf
group by b.season, b.referee_id;

create or replace view cfb_ref_baseline_3yr as
with mx as (select max(season) s from cfb_ref_game_penalties),
w as (select g.* from cfb_ref_game_penalties g, mx where g.season > mx.s - 3 and g.referee_id is not null),
lg as (select avg(flags)::numeric f, avg(holding_total)::numeric h from cfb_ref_game_penalties, mx
       where season > mx.s - 3)
select referee_id, max(referee) referee, count(*) games,
       round(avg(flags), 2) flags_pg, round(avg(holding_total), 2) holding_pg,
       round(avg(off_holding), 2) off_holding_pg,
       round(avg(flags) - (select f from lg), 2) flags_vs_fbs_pg,
       round(avg(holding_total) - (select h from lg), 2) holding_vs_fbs_pg
from w group by referee_id;

create or replace view cfb_game_ref_context as
select a.game_id, a.season, a.week, a.referee_id, a.referee, a.source, a.first_observed_at,
       s.primary_conf, s.games season_games, s.flags_pg season_flags_pg, s.holding_pg season_holding_pg,
       s.flags_vs_conf_pg, s.holding_vs_conf_pg,
       b.games y3_games, b.flags_pg y3_flags_pg, b.holding_pg y3_holding_pg,
       b.flags_vs_fbs_pg y3_flags_vs_fbs, b.holding_vs_fbs_pg y3_holding_vs_fbs
from cfb_ref_assignments a
left join cfb_ref_season_summary s on s.referee_id = a.referee_id and s.season = a.season
left join cfb_ref_baseline_3yr b on b.referee_id = a.referee_id;

alter table cfb_ref_game_penalties enable row level security;
alter table cfb_ref_assignments    enable row level security;
create policy "read cfb ref penalties"   on cfb_ref_game_penalties for select using (true);
create policy "read cfb ref assignments" on cfb_ref_assignments    for select using (true);
