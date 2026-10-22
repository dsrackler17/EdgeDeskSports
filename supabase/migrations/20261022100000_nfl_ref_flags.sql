-- =============================================================================
-- nfl_ref_flags.sql — NFL referee flag tendencies (T0, Observed): who is
-- officiating each game, and how many flags and holding calls his crew has
-- averaged against that season's league average. data/refs/README.md.
--
-- DISPLAY ONLY. Nothing here feeds a projection, spread, total, probability,
-- EV, grade, ranking or the CLV record, and nothing in those pipelines reads
-- these tables. A flag-adjusted number belongs in Research Models
-- (Experimental) and stays out of the model until it clears the
-- incremental-CLV test.
--
-- WHO WRITES. Only service_role: data/refs/upsert_refs.py (the one-time seed,
-- then .github/workflows/ref-sync.yml every Tuesday), upserting on game_id —
-- assignments first, then penalties (the foreign key).
-- WHO READS. anon and authenticated, as for the NFL card's other Observed
-- tables (nfl_market_structure.sql, contest_ownership.sql,
-- kalshi_market_data.sql): nflverse play-by-play and published referee
-- assignments are public. No client may write. Every view runs AS THE READER
-- (security_invoker), so a view never answers more than its tables would.
--
--   nfl_ref_assignments      game_id -> referee (nflverse; else Football Zebras)
--   nfl_ref_game_penalties   one row per played game: flags, holding, DPI, ...
--   nfl_ref_season_summary   per referee per season, against that season's
--                            league average, with ranks and the referee count
--   nfl_ref_baseline_3yr     the current season and the two before it
--   nfl_game_ref_context     what the game card reads, by game_id
--
-- SAFE OVER THE HANDOFF DRAFT. data/refs/schema.sql, if it was pasted first,
-- is upgraded in place: its two "using (true)" policies (granted to PUBLIC)
-- are replaced by the reader policies below, its views keep every column in
-- its place and gain the appended ones, and they now run as the reader.
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

begin;

-- ---------------------------------------------------------------- tables
create table if not exists public.nfl_ref_assignments (
  game_id     text primary key,          -- nflverse id, e.g. 2026_07_GB_DET
  season      int  not null,
  week        int  not null,
  referee     text not null,
  source      text not null default 'nflverse',  -- nflverse | footballzebras | manual
  updated_at  timestamptz not null default now()
);

create table if not exists public.nfl_ref_game_penalties (
  game_id                text primary key references public.nfl_ref_assignments(game_id),
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
  went_over              int,             -- 1 over, 0 under, null push (or no line)
  updated_at             timestamptz not null default now()
);

create index if not exists nfl_ref_gp_ref_season on public.nfl_ref_game_penalties (referee, season);

do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'nfl_ref_assignments_source_known') then
    alter table public.nfl_ref_assignments add constraint nfl_ref_assignments_source_known
      check (source in ('nflverse', 'footballzebras', 'manual'));
  end if;
end $c$;

-- updated_at follows every write: the REST upsert sends no timestamp
create or replace function public.nfl_ref_touch()
returns trigger language plpgsql as $t$
begin
  new.updated_at := now();
  return new;
end $t$;
drop trigger if exists nfl_ref_assignments_touch on public.nfl_ref_assignments;
create trigger nfl_ref_assignments_touch before insert or update on public.nfl_ref_assignments
  for each row execute function public.nfl_ref_touch();
drop trigger if exists nfl_ref_game_penalties_touch on public.nfl_ref_game_penalties;
create trigger nfl_ref_game_penalties_touch before insert or update on public.nfl_ref_game_penalties
  for each row execute function public.nfl_ref_touch();

-- ---------------------------------------------------------------- views
-- Per-ref averages for any season, compared to that season's league average.
-- Regular season only. Rank 1 = the most per game; refs = how many referees
-- worked a regular-season game that season (the "of N" in "rank 2 of 17").
create or replace view public.nfl_ref_season_summary with (security_invoker = true) as
with lg as (
  select season,
         avg(flags)::numeric          as lg_flags_pg,
         avg(holding_total)::numeric  as lg_holding_pg
    from public.nfl_ref_game_penalties where game_type = 'REG' group by season
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
       coalesce(sum(g.went_over), 0)                    as overs,
       count(g.went_over) - coalesce(sum(g.went_over), 0) as unders,
       rank() over (partition by g.season order by avg(g.flags) desc)         as flags_rank,
       rank() over (partition by g.season order by avg(g.holding_total) desc) as holding_rank,
       -- appended after the handoff's columns, which keep their places
       count(*) over (partition by g.season)            as refs,
       round(lg.lg_flags_pg, 2)                         as lg_flags_pg,
       round(lg.lg_holding_pg, 2)                       as lg_holding_pg,
       count(*) filter (where g.total = g.total_line)   as pushes
from public.nfl_ref_game_penalties g
join lg on lg.season = g.season
where g.game_type = 'REG'
group by g.season, g.referee, lg.lg_flags_pg, lg.lg_holding_pg;

-- Rolling 3-season baseline (the latest season on file + the two before it):
-- the stabler number, against the league average over the same games
create or replace view public.nfl_ref_baseline_3yr with (security_invoker = true) as
with mx as (select max(season) s from public.nfl_ref_game_penalties),
w as (select g.* from public.nfl_ref_game_penalties g, mx where g.game_type = 'REG' and g.season > mx.s - 3),
lg as (select avg(flags)::numeric f, avg(holding_total)::numeric h, min(season) s0, max(season) s1 from w)
select referee,
       count(*)                               as games,
       round(avg(flags), 2)                   as flags_pg,
       round(avg(holding_total), 2)           as holding_pg,
       round(avg(off_holding), 2)             as off_holding_pg,
       round(avg(dpi), 2)                     as dpi_pg,
       round(100.0 * sum(flags) / nullif(sum(snaps), 0), 2) as flags_per_100_snaps,
       round(avg(flags) - (select f from lg), 2)          as flags_vs_league_pg,
       round(avg(holding_total) - (select h from lg), 2)  as holding_vs_league_pg,
       -- appended after the handoff's columns, which keep their places
       (select s0 from lg)                    as first_season,
       (select s1 from lg)                    as last_season,
       round((select f from lg), 2)           as lg_flags_pg,
       round((select h from lg), 2)           as lg_holding_pg,
       coalesce(sum(went_over), 0)            as overs,
       count(went_over) - coalesce(sum(went_over), 0) as unders,
       count(*) filter (where total = total_line)     as pushes,
       count(*) over ()                       as refs
from w group by referee;

-- What the game card reads: the game's referee, his season and 3-year numbers.
-- A game with no row has no announced assignment.
create or replace view public.nfl_game_ref_context with (security_invoker = true) as
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
       b.holding_vs_league_pg as y3_holding_vs_league,
       -- appended after the handoff's columns, which keep their places
       s.refs           as season_refs,
       s.lg_flags_pg    as season_lg_flags_pg,
       s.lg_holding_pg  as season_lg_holding_pg,
       s.overs          as season_overs,
       s.unders         as season_unders,
       s.pushes         as season_pushes,
       b.first_season   as y3_first_season,
       b.last_season    as y3_last_season,
       b.lg_flags_pg    as y3_lg_flags_pg,
       b.lg_holding_pg  as y3_lg_holding_pg,
       b.overs          as y3_overs,
       b.unders         as y3_unders,
       b.pushes         as y3_pushes
from public.nfl_ref_assignments a
left join public.nfl_ref_season_summary s on s.referee = a.referee and s.season = a.season
left join public.nfl_ref_baseline_3yr  b on b.referee = a.referee;

-- ---------------------------------------------------------------- who reads, who writes
-- the handoff draft's policies were "for select using (true)" to PUBLIC
drop policy if exists "read ref assignments" on public.nfl_ref_assignments;
drop policy if exists "read ref penalties" on public.nfl_ref_game_penalties;
do $p$ declare t text; begin
  foreach t in array array['nfl_ref_assignments', 'nfl_ref_game_penalties'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to anon, authenticated using (true)', t || '_read', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to anon, authenticated', t);
  end loop;
  foreach t in array array['nfl_ref_season_summary', 'nfl_ref_baseline_3yr', 'nfl_game_ref_context'] loop
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to anon, authenticated', t);
  end loop;
end $p$;
revoke all on function public.nfl_ref_touch() from public, anon, authenticated;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update on public.nfl_ref_assignments, public.nfl_ref_game_penalties to service_role';
    execute 'grant select on public.nfl_ref_season_summary, public.nfl_ref_baseline_3yr, public.nfl_game_ref_context to service_role';
  end if;
end $g$;

commit;

notify pgrst, 'reload schema';

-- THE REPORT. Every row should say ok (row 7 says pending until the seed has run).
select piece, state from (
  select '1 tables and the referee-season index' as piece,
         case when to_regclass('public.nfl_ref_assignments') is not null and to_regclass('public.nfl_ref_game_penalties') is not null
               and to_regclass('public.nfl_ref_gp_ref_season') is not null then 'ok' else 'CHECK THIS' end as state
  union all select '2 a penalty row needs its assignment (load assignments first)',
         case when exists (select 1 from pg_constraint where conrelid = 'public.nfl_ref_game_penalties'::regclass and contype = 'f'
                             and confrelid = 'public.nfl_ref_assignments'::regclass) then 'ok' else 'CHECK THIS' end
  union all select '3 row level security on both tables',
         case when (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relrowsecurity
                      and relname in ('nfl_ref_assignments', 'nfl_ref_game_penalties')) = 2 then 'ok' else 'CHECK THIS' end
  union all select '4 readers read, only the service role writes (no client write, no PUBLIC policy)',
         case when has_table_privilege('anon', 'public.nfl_ref_assignments', 'select')
               and has_table_privilege('authenticated', 'public.nfl_ref_game_penalties', 'select')
               and not has_table_privilege('anon', 'public.nfl_ref_assignments', 'insert, update, delete')
               and not has_table_privilege('anon', 'public.nfl_ref_game_penalties', 'insert, update, delete')
               and not has_table_privilege('authenticated', 'public.nfl_ref_assignments', 'insert, update, delete')
               and not has_table_privilege('authenticated', 'public.nfl_ref_game_penalties', 'insert, update, delete')
               and not exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('nfl_ref_assignments', 'nfl_ref_game_penalties')
                                 and (cmd <> 'SELECT' or 'public' = any (roles)))
               and (not exists (select 1 from pg_roles where rolname = 'service_role')
                    or (has_table_privilege('service_role', 'public.nfl_ref_assignments', 'insert')
                        and has_table_privilege('service_role', 'public.nfl_ref_assignments', 'update')
                        and has_table_privilege('service_role', 'public.nfl_ref_game_penalties', 'insert')
                        and has_table_privilege('service_role', 'public.nfl_ref_game_penalties', 'update')))
              then 'ok' else 'CHECK THIS' end
  union all select '5 every view runs as the reader',
         case when (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'v'
                      and relname in ('nfl_ref_season_summary', 'nfl_ref_baseline_3yr', 'nfl_game_ref_context')
                      and coalesce(reloptions::text, '') like '%security_invoker=true%') = 3 then 'ok' else 'CHECK THIS' end
  union all select '6 the card view carries the rank denominator and the O/U record',
         case when (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'nfl_game_ref_context'
                      and column_name in ('season_refs', 'season_overs', 'season_unders', 'y3_games', 'y3_first_season')) = 5 then 'ok' else 'CHECK THIS' end
  union all select '7 the seed has run',
         case when exists (select 1 from public.nfl_ref_game_penalties) and exists (select 1 from public.nfl_ref_assignments) then 'ok'
              else 'pending: run SB_URL=... SB_SERVICE_ROLE=... python3 data/refs/upsert_refs.py (assignments, then penalties)' end
) r order by split_part(piece, ' ', 1)::int;
