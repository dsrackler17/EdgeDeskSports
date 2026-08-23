-- =====================================================================
-- collective.odds_link_games(p_league text) -> integer
--
-- Ties a stored odds event to the Collective game it is the market for, by
-- writing odds.events.collective_game_id. Returns how many it linked.
--
-- collective_odds_ingest already calls this at the end of every run:
--
--     const linked = await rpc<number>("odds_link_games", { p_league: leagueId })
--       .catch(() => 0);
--
-- Note the .catch(() => 0). Until now the function did not exist, so every
-- run reported games_linked: 0 -- which reads exactly like "nothing matched"
-- and is why it went unnoticed for as long as it did.
--
-- WHAT IT UNBLOCKS: the board renders without it, because the browser falls
-- back to matching on team codes. Closing lines and CLV do not: odds_closing_
-- for_game takes a Collective game id and has nothing to look up until this
-- link exists.
--
-- SAFE TO RUN REPEATEDLY. It only ever fills a NULL, never moves an existing
-- link, so a mistaken match is corrected by nulling that row and re-running,
-- not by fighting the function.
-- =====================================================================

create or replace function collective.odds_link_games(p_league text)
returns integer
language plpgsql
security definer
set search_path = collective, odds, public
as $fn$
declare
  v_sport text;
  v_n     integer := 0;
begin
  -- The odds layer names a LEAGUE ('ncaaf'); the Collective names a SPORT
  -- ('CFB'). Same map the three edge functions use.
  v_sport := case lower(coalesce(p_league,''))
               when 'nfl'   then 'NFL'
               when 'ncaaf' then 'CFB'
               when 'cfb'   then 'CFB'
               else upper(coalesce(p_league,''))
             end;

  -- Shape guards. A missing column would otherwise link nothing and return 0,
  -- which is indistinguishable from "no games matched" -- the same silence
  -- that hid the absence of this function. Fail loudly and name the problem.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'odds' and table_name = 'events'
       and column_name = 'collective_game_id')
  then
    raise exception
      'odds.events has no collective_game_id column, so there is nowhere to store the link. '
      'Columns present: %',
      (select string_agg(column_name, ', ' order by ordinal_position)
         from information_schema.columns
        where table_schema='odds' and table_name='events');
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'collective' and table_name = 'games'
       and column_name in ('home','away','kickoff_at','sport')
     group by table_name having count(*) = 4)
  then
    raise exception
      'collective.games does not have all of home, away, kickoff_at, sport. Columns present: %',
      (select string_agg(column_name, ', ' order by ordinal_position)
         from information_schema.columns
        where table_schema='collective' and table_name='games');
  end if;

  with cand as (
    select e.id as eid,
           g.id as gid,
           row_number() over (
             partition by e.id
             order by abs(extract(epoch from (g.kickoff_at - e.commence_time)))
           ) as rn
      from odds.events e
      join collective.games g
        on  upper(g.sport)  = v_sport
        -- The codes already agree on both sides: odds.team_aliases.team_code
        -- was seeded from collective.teams.code, so TCU is TCU. This is a
        -- straight join, not a second name-matching problem.
        and upper(g.home)   = upper(e.home_code)
        and upper(g.away)   = upper(e.away_code)
        -- Three days of drift. A flexed or rescheduled kickoff should update
        -- the same game, not fail to match it; the row_number above keeps the
        -- closest one when a team plays the same opponent twice in a window.
        and g.kickoff_at between e.commence_time - interval '3 days'
                             and e.commence_time + interval '3 days'
     where lower(e.league) = lower(p_league)
       and e.collective_game_id is null
       -- One event per game. Without this, a duplicate provider event would
       -- quietly claim a game that already has its market.
       and not exists (
         select 1 from odds.events x
          where x.collective_game_id = g.id)
  )
  update odds.events e
     set collective_game_id = cand.gid
    from cand
   where cand.eid = e.id
     and cand.rn  = 1;

  get diagnostics v_n = row_count;
  return v_n;
end
$fn$;

grant execute on function collective.odds_link_games(text) to service_role;
