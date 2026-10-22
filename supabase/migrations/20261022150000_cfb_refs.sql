-- =============================================================================
-- cfb_refs.sql — CFB referee flag tendencies (FBS, 2024-2026). Tier: Observed
-- (T0). DISPLAY ONLY: nothing here is read by a model, a classification
-- (INVESTIGATE / MONITOR / PASS), H-CFB-01, CLV grading or any ranking of games.
-- README §CFB referee flags; the data and how it was built: data/refs/cfb/.
--
-- Built from data/refs/cfb/cfb_schema.sql (the dataset's own migration), with
-- three changes the product rules need:
--   1. cfb_ref_assignments keeps HISTORY. The key is (game_id, referee_id), not
--      game_id: when ESPN changes a game's referee the replacement is a new row
--      with its own first_observed_at and the previous row stays for audit.
--      first_observed_at can never be rewritten (a trigger refuses it) and no
--      row can be deleted. last_observed_at says which referee ESPN lists now.
--   2. Every write goes through two functions (service_role only) that hold the
--      merge rules in one place:
--        cfb_ref_merge_games(rows, mode)    seed | espn_referee | espn_final
--        cfb_ref_observe_assignments(rows)  the Thursday / Friday pregame pull
--      A re-seed never undoes the ESPN backfill, the backfill never touches an
--      assignment_conflict row, and a weekly pull only fills what is missing.
--   3. A referee's conference is the dataset's documented mapping
--      (referee_primary_conf: the referee's most common conference across in-conference
--      games, cfb_enrich.py), read only from the dataset's own NCAA rows. It is
--      never inferred from a game's home team; a referee the dataset does not
--      map has primary_conf null and the card says "Conference unavailable".
--   The views add the conference and FBS averages themselves and a rank among
--   referees with at least 3 games (fewer: the numbers show, the rank is null).
--
-- WHO READS. Matches the CFB card's own tables (cfb.games / cfb.lines /
-- cfb.analyst_flags: RLS on, select only): anon and authenticated may select,
-- no client may write. The views run as the reader (security_invoker).
--
--   cfb_ref_game_penalties     one row per completed FBS game (ESPN game id =
--                              the CFB module's game_id, CFBD ids are ESPN's)
--   cfb_ref_assignments        pregame referee observations, history kept
--   cfb_ref_referees           referee_id -> display name, primary conference
--   cfb_ref_season_summary     per referee per season, vs conference and FBS
--   cfb_ref_baseline_3yr       per referee, the last three seasons
--   cfb_ref_assignment_current the referee ESPN lists now, per game
--   cfb_game_ref_context       what one game card shows, by game_id
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

begin;

-- ---------------------------------------------------------------- tables
create table if not exists public.cfb_ref_game_penalties (
  game_id               bigint primary key,      -- ESPN game id (= cfb.games.game_id)
  season                int not null,
  week                  int,
  start_date            timestamptz,
  neutral_site          boolean,
  home_team             text, away_team text,
  home_conference       text, away_conference text,
  home_points           int,  away_points int,
  referee_id            text,                    -- canonical name key; null = unknown
  referee               text,
  referee_primary_conf  text,                    -- the dataset's mapping, never the home team
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
create index if not exists cfb_ref_gp_ref on public.cfb_ref_game_penalties (referee_id, season);

create table if not exists public.cfb_ref_assignments (
  game_id           bigint not null,
  season            int not null,
  week              int,
  referee_id        text not null,
  referee           text,
  source            text not null,
  first_observed_at timestamptz not null default now(),
  last_observed_at  timestamptz not null default now(),
  primary key (game_id, referee_id)
);
create index if not exists cfb_ref_asg_game on public.cfb_ref_assignments (game_id, last_observed_at desc);

-- ---------------------------------------------------------------- the audit guard
-- An observation is the record: who was listed, and when EdgeDesk first saw it.
-- Only last_observed_at may move, and only forward.
create or replace function public.cfb_ref_assignments_guard()
returns trigger language plpgsql as $g$
begin
  if tg_op = 'UPDATE' then
    if new.game_id is distinct from old.game_id or new.referee_id is distinct from old.referee_id
       or new.first_observed_at is distinct from old.first_observed_at or new.source is distinct from old.source
       or new.season is distinct from old.season then
      raise exception 'public.cfb_ref_assignments: only last_observed_at may change (first_observed_at is the record)';
    end if;
    if new.last_observed_at < old.last_observed_at then
      new.last_observed_at := old.last_observed_at;
    end if;
    return new;
  end if;
  raise exception 'public.cfb_ref_assignments keeps every observation: % refused', tg_op;
end $g$;
drop trigger if exists cfb_ref_assignments_guard_upd on public.cfb_ref_assignments;
create trigger cfb_ref_assignments_guard_upd before update on public.cfb_ref_assignments
  for each row execute function public.cfb_ref_assignments_guard();
drop trigger if exists cfb_ref_assignments_guard_del on public.cfb_ref_assignments;
create trigger cfb_ref_assignments_guard_del before delete on public.cfb_ref_assignments
  for each row execute function public.cfb_ref_assignments_guard();
drop trigger if exists cfb_ref_assignments_guard_trunc on public.cfb_ref_assignments;
create trigger cfb_ref_assignments_guard_trunc before truncate on public.cfb_ref_assignments
  for each statement execute function public.cfb_ref_assignments_guard();

-- ---------------------------------------------------------------- the conference mapping
-- The dataset's documented mapping, read only from its own NCAA rows. An ESPN
-- row never contributes a conference, so a referee ESPN introduces stays null.
create or replace function public.cfb_ref_primary_conf(p_referee_id text)
returns text language sql stable set search_path = pg_catalog, pg_temp as $f$
  select max(referee_primary_conf)
    from public.cfb_ref_game_penalties
   where referee_id = p_referee_id
     and referee_source in ('ncaa_listed', 'ncaa_matched_by_date_teams');
$f$;

-- ---------------------------------------------------------------- writes (service_role only)
-- p_mode:
--   seed          the validated dataset (data/refs/cfb/cfb_ref_game_penalties.csv):
--                 upsert on game_id, every column from the file, EXCEPT that a
--                 null referee in the file never erases one the ESPN backfill
--                 filled (referee_source = 'espn').
--   espn_referee  the backfill: sets the referee on rows that have none and are
--                 not assignment_conflict. Never inserts, never changes a
--                 measurement. source espn, identity espn_referee_role.
--   espn_final    the Sunday pull: inserts games not yet stored; on a stored
--                 game it only fills columns that are null (validated numbers
--                 are never rewritten), and the referee only as espn_referee does.
create or replace function public.cfb_ref_merge_games(p_rows jsonb, p_mode text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $m$
declare
  n_ins int := 0; n_upd int := 0; n_in int := coalesce(jsonb_array_length(p_rows), 0);
begin
  if p_mode not in ('seed', 'espn_referee', 'espn_final') then
    raise exception 'cfb_ref_merge_games: unknown mode %', p_mode;
  end if;
  if n_in = 0 then return jsonb_build_object('mode', p_mode, 'rows', 0, 'inserted', 0, 'updated', 0); end if;

  if p_mode = 'seed' then
    with up as (
      insert into public.cfb_ref_game_penalties as t (
        game_id, season, week, start_date, neutral_site, home_team, away_team, home_conference, away_conference,
        home_points, away_points, referee_id, referee, referee_primary_conf, referee_source, referee_identity,
        assignment_conflict, flags, penalty_yards, home_flags, away_flags, home_penalty_yards, away_penalty_yards,
        holding_total, off_holding, def_holding, holding_side_unknown, dpi, opi, false_start, scrimmage_plays,
        flags_per_100_plays, pbp_available, source_url, updated_at)
      select r.game_id, r.season, r.week, r.start_date, r.neutral_site, r.home_team, r.away_team, r.home_conference, r.away_conference,
             r.home_points, r.away_points, r.referee_id, r.referee, r.referee_primary_conf, r.referee_source, r.referee_identity,
             coalesce(r.assignment_conflict, false), r.flags, r.penalty_yards, r.home_flags, r.away_flags, r.home_penalty_yards, r.away_penalty_yards,
             r.holding_total, r.off_holding, r.def_holding, r.holding_side_unknown, r.dpi, r.opi, r.false_start, r.scrimmage_plays,
             r.flags_per_100_plays, r.pbp_available, r.source_url, now()
        from jsonb_populate_recordset(null::public.cfb_ref_game_penalties, p_rows) r
      on conflict (game_id) do update set
        season = excluded.season, week = excluded.week, start_date = excluded.start_date, neutral_site = excluded.neutral_site,
        home_team = excluded.home_team, away_team = excluded.away_team,
        home_conference = excluded.home_conference, away_conference = excluded.away_conference,
        home_points = excluded.home_points, away_points = excluded.away_points,
        referee_id           = case when excluded.referee_id is null and t.referee_source = 'espn' then t.referee_id           else excluded.referee_id end,
        referee              = case when excluded.referee_id is null and t.referee_source = 'espn' then t.referee              else excluded.referee end,
        referee_primary_conf = case when excluded.referee_id is null and t.referee_source = 'espn' then t.referee_primary_conf else excluded.referee_primary_conf end,
        referee_source       = case when excluded.referee_id is null and t.referee_source = 'espn' then t.referee_source       else excluded.referee_source end,
        referee_identity     = case when excluded.referee_id is null and t.referee_source = 'espn' then t.referee_identity     else excluded.referee_identity end,
        assignment_conflict = excluded.assignment_conflict,
        flags = excluded.flags, penalty_yards = excluded.penalty_yards, home_flags = excluded.home_flags, away_flags = excluded.away_flags,
        home_penalty_yards = excluded.home_penalty_yards, away_penalty_yards = excluded.away_penalty_yards,
        holding_total = excluded.holding_total, off_holding = excluded.off_holding, def_holding = excluded.def_holding,
        holding_side_unknown = excluded.holding_side_unknown, dpi = excluded.dpi, opi = excluded.opi, false_start = excluded.false_start,
        scrimmage_plays = excluded.scrimmage_plays, flags_per_100_plays = excluded.flags_per_100_plays,
        pbp_available = excluded.pbp_available, source_url = excluded.source_url, updated_at = now()
      returning (xmax = 0) as inserted
    )
    select count(*) filter (where inserted), count(*) filter (where not inserted) into n_ins, n_upd from up;

  elsif p_mode = 'espn_referee' then
    with r as (
      select distinct on (x.game_id) x.game_id, x.referee_id, x.referee
        from jsonb_populate_recordset(null::public.cfb_ref_game_penalties, p_rows) x
       where x.referee_id is not null and x.referee_id ~ '^[a-z]+$'
       order by x.game_id
    ), up as (
      update public.cfb_ref_game_penalties t set
        referee_id = r.referee_id, referee = r.referee,
        referee_primary_conf = public.cfb_ref_primary_conf(r.referee_id),
        referee_source = 'espn', referee_identity = 'espn_referee_role', updated_at = now()
        from r
       where t.game_id = r.game_id and t.referee_id is null and not coalesce(t.assignment_conflict, false)
      returning 1
    )
    select count(*) into n_upd from up;

  else  -- espn_final
    with r as (
      select x.*,
             case when x.referee_id ~ '^[a-z]+$' then x.referee_id end as rid
        from jsonb_populate_recordset(null::public.cfb_ref_game_penalties, p_rows) x
    ), up as (
      insert into public.cfb_ref_game_penalties as t (
        game_id, season, week, start_date, neutral_site, home_team, away_team, home_conference, away_conference,
        home_points, away_points, referee_id, referee, referee_primary_conf, referee_source, referee_identity,
        assignment_conflict, flags, penalty_yards, home_flags, away_flags, home_penalty_yards, away_penalty_yards,
        holding_total, off_holding, def_holding, holding_side_unknown, dpi, opi, false_start, scrimmage_plays,
        flags_per_100_plays, pbp_available, source_url, updated_at)
      select r.game_id, r.season, r.week, r.start_date, r.neutral_site, r.home_team, r.away_team, r.home_conference, r.away_conference,
             r.home_points, r.away_points, r.rid, case when r.rid is not null then r.referee end,
             case when r.rid is not null then public.cfb_ref_primary_conf(r.rid) end,
             case when r.rid is not null then 'espn' end, case when r.rid is not null then 'espn_referee_role' end,
             false, r.flags, r.penalty_yards, r.home_flags, r.away_flags, r.home_penalty_yards, r.away_penalty_yards,
             r.holding_total, r.off_holding, r.def_holding, r.holding_side_unknown, r.dpi, r.opi, r.false_start, r.scrimmage_plays,
             r.flags_per_100_plays, r.pbp_available, r.source_url, now()
        from r
      on conflict (game_id) do update set
        week = coalesce(t.week, excluded.week), start_date = coalesce(t.start_date, excluded.start_date),
        neutral_site = coalesce(t.neutral_site, excluded.neutral_site),
        home_team = coalesce(t.home_team, excluded.home_team), away_team = coalesce(t.away_team, excluded.away_team),
        home_conference = coalesce(t.home_conference, excluded.home_conference), away_conference = coalesce(t.away_conference, excluded.away_conference),
        home_points = coalesce(t.home_points, excluded.home_points), away_points = coalesce(t.away_points, excluded.away_points),
        referee_id           = case when t.referee_id is null and not coalesce(t.assignment_conflict, false) and excluded.referee_id is not null then excluded.referee_id           else t.referee_id end,
        referee              = case when t.referee_id is null and not coalesce(t.assignment_conflict, false) and excluded.referee_id is not null then excluded.referee              else t.referee end,
        referee_primary_conf = case when t.referee_id is null and not coalesce(t.assignment_conflict, false) and excluded.referee_id is not null then excluded.referee_primary_conf else t.referee_primary_conf end,
        referee_source       = case when t.referee_id is null and not coalesce(t.assignment_conflict, false) and excluded.referee_id is not null then excluded.referee_source       else t.referee_source end,
        referee_identity     = case when t.referee_id is null and not coalesce(t.assignment_conflict, false) and excluded.referee_id is not null then excluded.referee_identity     else t.referee_identity end,
        flags = coalesce(t.flags, excluded.flags), penalty_yards = coalesce(t.penalty_yards, excluded.penalty_yards),
        home_flags = coalesce(t.home_flags, excluded.home_flags), away_flags = coalesce(t.away_flags, excluded.away_flags),
        home_penalty_yards = coalesce(t.home_penalty_yards, excluded.home_penalty_yards), away_penalty_yards = coalesce(t.away_penalty_yards, excluded.away_penalty_yards),
        holding_total = coalesce(t.holding_total, excluded.holding_total), off_holding = coalesce(t.off_holding, excluded.off_holding),
        def_holding = coalesce(t.def_holding, excluded.def_holding), holding_side_unknown = coalesce(t.holding_side_unknown, excluded.holding_side_unknown),
        dpi = coalesce(t.dpi, excluded.dpi), opi = coalesce(t.opi, excluded.opi), false_start = coalesce(t.false_start, excluded.false_start),
        scrimmage_plays = coalesce(t.scrimmage_plays, excluded.scrimmage_plays), flags_per_100_plays = coalesce(t.flags_per_100_plays, excluded.flags_per_100_plays),
        pbp_available = coalesce(t.pbp_available, excluded.pbp_available), source_url = coalesce(t.source_url, excluded.source_url),
        updated_at = now()
      where (t.referee_id is null and not coalesce(t.assignment_conflict, false) and excluded.referee_id is not null)
         or (t.flags is null and excluded.flags is not null) or (t.penalty_yards is null and excluded.penalty_yards is not null)
         or (t.home_flags is null and excluded.home_flags is not null) or (t.away_flags is null and excluded.away_flags is not null)
         or (t.holding_total is null and excluded.holding_total is not null) or (t.off_holding is null and excluded.off_holding is not null)
         or (t.def_holding is null and excluded.def_holding is not null) or (t.dpi is null and excluded.dpi is not null)
         or (t.opi is null and excluded.opi is not null) or (t.false_start is null and excluded.false_start is not null)
         or (t.scrimmage_plays is null and excluded.scrimmage_plays is not null) or (t.home_points is null and excluded.home_points is not null)
         or (t.away_points is null and excluded.away_points is not null) or (t.pbp_available is null and excluded.pbp_available is not null)
      returning (xmax = 0) as inserted
    )
    select count(*) filter (where inserted), count(*) filter (where not inserted) into n_ins, n_upd from up;
  end if;

  return jsonb_build_object('mode', p_mode, 'rows', n_in, 'inserted', n_ins, 'updated', n_upd, 'unchanged', n_in - n_ins - n_upd);
end $m$;

-- The Thursday / Friday pull. One row per game ESPN lists a Referee for. A new
-- (game, referee) pair is inserted with first_observed_at = now(); a pair seen
-- before only moves last_observed_at. A game whose referee changed keeps the
-- earlier row: 'replaced' counts those games.
create or replace function public.cfb_ref_observe_assignments(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $o$
declare
  n_new int := 0; n_seen int := 0; n_repl int := 0; n_in int := coalesce(jsonb_array_length(p_rows), 0);
begin
  if n_in = 0 then return jsonb_build_object('rows', 0, 'new', 0, 'seen_again', 0, 'replaced', 0); end if;
  -- every CTE reads the table as it was before this insert, so `repl` counts
  -- games that already had a different referee and now get a new one
  with i as (
    select distinct on (x.game_id) x.game_id, x.season, x.week, x.referee_id, x.referee, coalesce(nullif(x.source, ''), 'espn') as source
      from jsonb_to_recordset(p_rows) as x(game_id bigint, season int, week int, referee_id text, referee text, source text)
     where x.game_id is not null and x.season is not null and x.referee_id ~ '^[a-z]+$'
     order by x.game_id
  ), repl as (
    select count(*) as n from i
     where exists (select 1 from public.cfb_ref_assignments a where a.game_id = i.game_id and a.referee_id <> i.referee_id)
       and not exists (select 1 from public.cfb_ref_assignments a where a.game_id = i.game_id and a.referee_id = i.referee_id)
  ), up as (
    insert into public.cfb_ref_assignments as t (game_id, season, week, referee_id, referee, source, first_observed_at, last_observed_at)
    select game_id, season, week, referee_id, referee, source, now(), now() from i
    on conflict (game_id, referee_id) do update set last_observed_at = greatest(t.last_observed_at, excluded.last_observed_at)
    returning (xmax = 0) as inserted
  )
  select (select n from repl), count(*) filter (where inserted), count(*) filter (where not inserted)
    into n_repl, n_new, n_seen from up;

  return jsonb_build_object('rows', n_in, 'new', n_new, 'seen_again', n_seen, 'replaced', n_repl);
end $o$;

-- ---------------------------------------------------------------- views
create or replace view public.cfb_ref_referees with (security_invoker = true) as
select g.referee_id,
       (array_agg(g.referee order by (g.referee_source = 'espn'), g.start_date desc nulls last))[1] as referee,
       max(g.referee_primary_conf) filter (where g.referee_source in ('ncaa_listed', 'ncaa_matched_by_date_teams')) as primary_conf,
       count(*) as games, min(g.season) as first_season, max(g.season) as last_season
  from public.cfb_ref_game_penalties g
 where g.referee_id is not null
 group by g.referee_id;

create or replace view public.cfb_ref_season_summary with (security_invoker = true) as
with base as (select * from public.cfb_ref_game_penalties where referee_id is not null),
conf as (
  select season, home_conference as conf, count(*) as games, avg(flags)::numeric as f, avg(holding_total)::numeric as h
    from public.cfb_ref_game_penalties where home_conference = away_conference group by 1, 2
),
fbs as (select season, avg(flags)::numeric as f, avg(holding_total)::numeric as h from public.cfb_ref_game_penalties group by 1),
agg as (
  select b.season, b.referee_id, count(*) as games, count(b.holding_total) as holding_games,
         avg(b.flags)::numeric as f, avg(b.penalty_yards)::numeric as y, avg(b.holding_total)::numeric as h,
         avg(b.off_holding)::numeric as oh, avg(b.def_holding)::numeric as dh, avg(b.dpi)::numeric as dpi,
         avg(b.home_flags - b.away_flags)::numeric as hma,
         100.0 * sum(b.flags) filter (where b.scrimmage_plays is not null) / nullif(sum(b.scrimmage_plays), 0) as f100
    from base b group by 1, 2
),
j as (
  select a.*, r.referee, r.primary_conf, c.f as conf_f, c.h as conf_h, x.f as fbs_f, x.h as fbs_h
    from agg a
    join public.cfb_ref_referees r on r.referee_id = a.referee_id
    join fbs x on x.season = a.season
    left join conf c on c.season = a.season and c.conf = r.primary_conf
),
rk as (   -- ranks count only referees with at least 3 games that season (1 = most)
  select season, referee_id,
         case when primary_conf is not null then rank() over (partition by season, primary_conf order by f desc) end as flags_rank_in_conf,
         case when primary_conf is not null and h is not null then rank() over (partition by season, primary_conf order by h desc nulls last) end as holding_rank_in_conf,
         case when primary_conf is not null then count(*) over (partition by season, primary_conf) end as conf_refs_ranked,
         rank() over (partition by season order by f desc) as flags_rank_fbs,
         case when h is not null then rank() over (partition by season order by h desc nulls last) end as holding_rank_fbs,
         count(*) over (partition by season) as fbs_refs_ranked
    from j where games >= 3
)
select j.season, j.referee_id, j.referee, j.primary_conf, j.games, j.holding_games,
       round(j.f, 2) as flags_pg, round(j.y, 2) as penalty_yards_pg, round(j.h, 2) as holding_pg,
       round(j.oh, 2) as off_holding_pg, round(j.dh, 2) as def_holding_pg, round(j.dpi, 2) as dpi_pg,
       round(j.hma, 2) as home_minus_away_pg, round(j.f100, 2) as flags_per_100_plays,
       round(j.conf_f, 2) as conf_flags_pg, round(j.conf_h, 2) as conf_holding_pg,
       round(j.fbs_f, 2) as fbs_flags_pg, round(j.fbs_h, 2) as fbs_holding_pg,
       round(j.f - j.conf_f, 2) as flags_vs_conf_pg, round(j.h - j.conf_h, 2) as holding_vs_conf_pg,
       round(j.f - j.fbs_f, 2) as flags_vs_fbs_pg, round(j.h - j.fbs_h, 2) as holding_vs_fbs_pg,
       rk.flags_rank_in_conf, rk.holding_rank_in_conf, rk.conf_refs_ranked,
       rk.flags_rank_fbs, rk.holding_rank_fbs, rk.fbs_refs_ranked
  from j left join rk on rk.season = j.season and rk.referee_id = j.referee_id;

create or replace view public.cfb_ref_baseline_3yr with (security_invoker = true) as
with mx as (select max(season) as s from public.cfb_ref_game_penalties),
w as (select g.* from public.cfb_ref_game_penalties g, mx where g.season > mx.s - 3 and g.referee_id is not null),
lg as (select avg(flags)::numeric as f, avg(holding_total)::numeric as h
         from public.cfb_ref_game_penalties, mx where season > mx.s - 3),
a as (select referee_id, count(*) as games, count(holding_total) as holding_games,
             avg(flags)::numeric as f, avg(holding_total)::numeric as h, avg(off_holding)::numeric as oh
        from w group by referee_id)
select a.referee_id, r.referee, r.primary_conf, a.games, a.holding_games,
       (select s - 2 from mx) as first_season, (select s from mx) as last_season,
       round(a.f, 2) as flags_pg, round(a.h, 2) as holding_pg, round(a.oh, 2) as off_holding_pg,
       round(a.f - lg.f, 2) as flags_vs_fbs_pg, round(a.h - lg.h, 2) as holding_vs_fbs_pg
  from a join public.cfb_ref_referees r on r.referee_id = a.referee_id cross join lg;

-- The referee ESPN lists now (latest observation), and how many referees have
-- been observed for the game in all (more than 1 = ESPN changed it).
create or replace view public.cfb_ref_assignment_current with (security_invoker = true) as
select distinct on (a.game_id) a.game_id, a.season, a.week, a.referee_id, a.referee, a.source,
       a.first_observed_at, a.last_observed_at,
       count(*) over (partition by a.game_id) as observed_referees
  from public.cfb_ref_assignments a
 order by a.game_id, a.last_observed_at desc, a.first_observed_at desc;

-- One row per game with a known referee: the game record when the game is
-- final and its referee is known, else the current pregame assignment. A game
-- with neither has no row ("Assignment not announced").
create or replace view public.cfb_game_ref_context with (security_invoker = true) as
with fin as (
  select game_id, season, week, referee_id, referee_source, referee_identity
    from public.cfb_ref_game_penalties where referee_id is not null
),
pick as (
  select coalesce(f.game_id, a.game_id) as game_id,
         coalesce(f.season, a.season) as season,
         coalesce(f.week, a.week) as week,
         coalesce(f.referee_id, a.referee_id) as referee_id,
         case when f.game_id is not null then 'game_record' else 'assignment' end as basis,
         coalesce(f.referee_source, a.source) as source,
         coalesce(f.referee_identity, case when a.source = 'espn' then 'espn_referee_role' end) as referee_identity,
         case when a.referee_id = coalesce(f.referee_id, a.referee_id) then a.first_observed_at end as first_observed_at,
         coalesce(a.observed_referees, 0) as observed_referees
    from fin f full join public.cfb_ref_assignment_current a on a.game_id = f.game_id
)
select p.game_id, p.season, p.week, p.referee_id, coalesce(r.referee, a2.referee) as referee, p.source, p.referee_identity,
       p.basis, p.first_observed_at, p.observed_referees,
       r.primary_conf,
       s.games as season_games, s.holding_games as season_holding_games,
       s.flags_pg as season_flags_pg, s.holding_pg as season_holding_pg, s.off_holding_pg as season_off_holding_pg,
       s.conf_flags_pg, s.conf_holding_pg, s.fbs_flags_pg, s.fbs_holding_pg,
       s.flags_vs_conf_pg, s.holding_vs_conf_pg, s.flags_vs_fbs_pg, s.holding_vs_fbs_pg,
       s.flags_rank_in_conf, s.holding_rank_in_conf, s.conf_refs_ranked,
       s.flags_rank_fbs, s.holding_rank_fbs, s.fbs_refs_ranked,
       b.games as y3_games, b.holding_games as y3_holding_games, b.first_season as y3_first_season, b.last_season as y3_last_season,
       b.flags_pg as y3_flags_pg, b.holding_pg as y3_holding_pg, b.off_holding_pg as y3_off_holding_pg,
       b.flags_vs_fbs_pg as y3_flags_vs_fbs, b.holding_vs_fbs_pg as y3_holding_vs_fbs
  from pick p
  left join public.cfb_ref_referees r on r.referee_id = p.referee_id
  left join public.cfb_ref_assignment_current a2 on a2.game_id = p.game_id and a2.referee_id = p.referee_id
  left join public.cfb_ref_season_summary s on s.referee_id = p.referee_id and s.season = p.season
  left join public.cfb_ref_baseline_3yr b on b.referee_id = p.referee_id;

-- ---------------------------------------------------------------- access
do $p$ declare t text; begin
  foreach t in array array['cfb_ref_game_penalties', 'cfb_ref_assignments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to anon, authenticated using (true)', t || '_read', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to anon, authenticated', t);
  end loop;
end $p$;
grant select on public.cfb_ref_referees, public.cfb_ref_season_summary, public.cfb_ref_baseline_3yr,
                public.cfb_ref_assignment_current, public.cfb_game_ref_context to anon, authenticated;
revoke all on function public.cfb_ref_merge_games(jsonb, text) from public, anon, authenticated;
revoke all on function public.cfb_ref_observe_assignments(jsonb) from public, anon, authenticated;
revoke all on function public.cfb_ref_assignments_guard() from public, anon, authenticated;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update on public.cfb_ref_game_penalties, public.cfb_ref_assignments to service_role';
    execute 'grant select on public.cfb_ref_referees, public.cfb_ref_season_summary, public.cfb_ref_baseline_3yr, public.cfb_ref_assignment_current, public.cfb_game_ref_context to service_role';
    execute 'grant execute on function public.cfb_ref_merge_games(jsonb, text) to service_role';
    execute 'grant execute on function public.cfb_ref_observe_assignments(jsonb) to service_role';
  end if;
end $g$;

commit;

notify pgrst, 'reload schema';

-- THE REPORT. Every row should say ok (row 7 says pending until the seed runs).
select piece, state from (
  select '1 two tables, row level security on both' as piece,
         case when (select count(*) from pg_class where relnamespace = 'public'::regnamespace
                     and relname in ('cfb_ref_game_penalties', 'cfb_ref_assignments') and relrowsecurity) = 2 then 'ok' else 'CHECK THIS' end as state
  union all select '2 assignments keep history: key (game_id, referee_id)',
         case when (select array_agg(a.attname::text order by a.attname)
                      from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
                     where i.indrelid = 'public.cfb_ref_assignments'::regclass and i.indisprimary) = array['game_id', 'referee_id']
              then 'ok' else 'CHECK THIS: an older cfb_ref_assignments keyed on game_id alone exists; it cannot keep a replaced referee' end
  union all select '3 first_observed_at cannot be rewritten, no observation can be deleted',
         case when (select count(*) from pg_trigger where tgrelid = 'public.cfb_ref_assignments'::regclass and not tgisinternal
                     and tgname in ('cfb_ref_assignments_guard_upd', 'cfb_ref_assignments_guard_del', 'cfb_ref_assignments_guard_trunc')) = 3 then 'ok' else 'CHECK THIS' end
  union all select '4 no client write: select-only policies, writers are service_role functions',
         case when not exists (select 1 from pg_policies where schemaname = 'public' and tablename like 'cfb\_ref\_%' escape '\' and cmd <> 'SELECT')
               and not has_function_privilege('anon', 'public.cfb_ref_merge_games(jsonb, text)', 'execute')
               and not has_function_privilege('anon', 'public.cfb_ref_observe_assignments(jsonb)', 'execute')
               and not has_table_privilege('anon', 'public.cfb_ref_game_penalties', 'insert') then 'ok' else 'CHECK THIS' end
  union all select '5 the card can read: anon selects cfb_game_ref_context',
         case when has_table_privilege('anon', 'public.cfb_game_ref_context', 'select') then 'ok' else 'CHECK THIS' end
  union all select '6 views: referees, season summary, 3-yr baseline, current assignment, game context',
         case when to_regclass('public.cfb_ref_referees') is not null and to_regclass('public.cfb_ref_season_summary') is not null
               and to_regclass('public.cfb_ref_baseline_3yr') is not null and to_regclass('public.cfb_ref_assignment_current') is not null
               and to_regclass('public.cfb_game_ref_context') is not null then 'ok' else 'CHECK THIS' end
  union all select '7 seeded (data/refs/cfb/cfb_ref_game_penalties.csv: 2,366 games)',
         case when (select count(*) from public.cfb_ref_game_penalties) >= 2366 then 'ok'
              else 'pending: ' || (select count(*) from public.cfb_ref_game_penalties) || ' rows; run Deploy CFB refs (seed) next' end
) r order by 1;
