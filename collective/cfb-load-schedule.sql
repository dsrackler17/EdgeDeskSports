-- LOAD THE CFB SCHEDULE INTO THE COLLECTIVE
--
-- EdgeDesk already ingests CollegeFootballData into the `cfb` schema, so the
-- Collective can take the slate straight from your own data instead of a CSV
-- that goes stale. Run this in the Supabase SQL editor.
--
-- Run STEP 1 first and read the output, then run STEP 2.

-- ============================================================
-- STEP 1: find your games table and its column names
-- ============================================================
-- This prints every column of every cfb table whose name looks like games.
-- You are looking for: season, week, kickoff/start time, home team, away team.

select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'cfb'
  and table_name like '%game%'
order by table_name, ordinal_position;

-- ============================================================
-- STEP 2: load the slate
-- ============================================================
-- Adjust the four column names in the SELECT below to match STEP 1 output,
-- and set the season. Everything else can stay as it is.
--
-- The insert is idempotent: games are keyed by (sport, season, home, away,
-- kickoff date), so re-running after a schedule update corrects kickoff times
-- and weeks instead of creating duplicates. Safe to run every week.

do $$
declare
  v_season int := 2026;          -- <<< the season to load
  v_loaded int := 0;
  v_skipped int := 0;
  g record;
  v_home uuid;
  v_away uuid;
begin
  for g in execute format($q$
    select
      week          as week,          -- <<< your week column
      start_date    as kickoff,       -- <<< your kickoff timestamp column
      home_team     as home,          -- <<< your home team name column
      away_team     as away           -- <<< your away team name column
    from cfb.games
    where season = %s
      and coalesce(season_type, 'regular') = 'regular'
  $q$, v_season)
  loop
    v_home := collective.resolve_team('CFB', g.home);
    v_away := collective.resolve_team('CFB', g.away);

    -- FCS opponents and any unfamiliar spelling are skipped, never guessed.
    if v_home is null or v_away is null or g.kickoff is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    insert into collective.games (sport_code, season, week, kickoff_at, home_team_id, away_team_id)
    values ('CFB', v_season, nullif(g.week::text,'')::int, g.kickoff::timestamptz, v_home, v_away)
    on conflict (sport_code, season, home_team_id, away_team_id, ((kickoff_at at time zone 'UTC')::date))
    do update set week = excluded.week, kickoff_at = excluded.kickoff_at;

    v_loaded := v_loaded + 1;
  end loop;

  raise notice 'CFB % : % games loaded, % skipped (unmatched team or missing kickoff)',
    v_season, v_loaded, v_skipped;
end $$;

-- ============================================================
-- STEP 2B (alternative): export a CSV instead
-- ============================================================
-- Prefer the Games tab? Run this instead of STEP 2, copy the single output
-- column, and paste it into Admin, Games. Same four fields as the NFL file.
-- Adjust the column names the same way.

select string_agg(
         week::text || ', ' ||
         to_char(kickoff at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || ', ' ||
         home || ', ' || away,
         E'\n' order by kickoff)
from (
  select week, start_date as kickoff, home_team as home, away_team as away
  from cfb.games
  where season = 2026 and coalesce(season_type,'regular') = 'regular'
    and start_date is not null
) s;

-- ============================================================
-- STEP 3: check what landed
-- ============================================================
select week, count(*) as games, min(kickoff_at) as first_kick, max(kickoff_at) as last_kick
from collective.games
where sport_code = 'CFB' and season = 2026
group by week
order by week;

-- Any team names your cfb data uses that the Collective does not know yet.
-- Add them under Admin, Quarantine, "add a team alias", or insert directly:
--   insert into collective.team_aliases (sport_code, alias, team_id)
--   values ('CFB', 'Their Spelling', (select id from collective.teams
--                                     where sport_code='CFB' and code='OHIOSTATE'));
