-- Fix Model Collective CFB/NCAAF odds linkage.
--
-- The odds schema stores college football as league='ncaaf', while the
-- Collective schedule stores it as sport='CFB'. The old linker compared those
-- strings literally, so every NCAAF odds event stayed unlinked and settled CFB
-- games could never inherit a captured closing spread for ATS grading.
--
-- Keep the published grading rule intact: ATS is still graded only against the
-- captured market close. This change only fixes the league-to-sport mapping.

create or replace function odds.link_collective_games(p_league text default 'nfl')
returns integer
language plpgsql
security definer
set search_path to 'odds', 'public'
as $function$
declare
  v_linked int := 0;
begin
  if to_regclass('collective.game_detail') is null then
    return 0;
  end if;

  execute format($q$
    with cand as (
      select g.game_id, g.season, g.week,
             odds.resolve_team(%L, g.home) as home_code,
             odds.resolve_team(%L, g.away) as away_code,
             odds.league_day(g.kickoff_at, %L) as kdate
      from collective.game_detail g
      where case
        when lower(%L) in ('ncaaf','cfb')
          then lower(g.sport) in ('cfb','ncaaf','cfb-p4')
        else lower(g.sport) = lower(%L)
      end
    )
    update odds.events e
       set collective_game_id = cand.game_id,
           season = coalesce(cand.season, e.season),
           week   = coalesce(cand.week, e.week),
           last_updated = now()
      from cand
     where e.league = %L
       and cand.home_code is not null
       and cand.away_code is not null
       and e.home_code = cand.home_code
       and e.away_code = cand.away_code
       and e.commence_date = cand.kdate
       and (e.collective_game_id is distinct from cand.game_id
            or e.season is distinct from cand.season
            or e.week is distinct from cand.week)
  $q$, p_league, p_league, p_league, p_league, p_league, p_league);

  get diagnostics v_linked = row_count;
  return v_linked;
exception when others then
  raise notice 'odds.link_collective_games skipped: %', sqlerrm;
  return 0;
end;
$function$;
