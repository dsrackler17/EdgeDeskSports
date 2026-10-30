-- The cards the NHL goalie sync job lists (.github/workflows/nhl-goalie-sync.yml;
-- tools/hockey/nhl_goalie_run_summary.js): one line of JSON, the current version
-- of every game from 6 hours ago (public.nhl_game_cards_current) to 24 hours
-- ahead, and what its headline is priced by. A card priced at lineup lock
-- (headline.basis 'lineup_lock', docs/engine/NHL_GOALIES.md §11) says so, with
-- the slate's price before lock; any other card is the slate's. Each card also
-- carries its game's timing probe: what every recorded sync run read in the NHL
-- boxscore from 4 hours before puck drop to an hour after (sources ->
-- nhl_api_boxscore -> games; by finished_at, which is indexed): the reads, the minutes before puck drop at which
-- both dressed lineups were first listed (negative: after puck drop), and the
-- last read before puck drop. Read-only.
select coalesce(json_agg(json_build_object(
         'game_id', c.game_id, 'matchup', c.away || '@' || c.home, 'start_utc', c.game_start_utc,
         'version', c.version, 'generated_at', c.generated_at, 'trigger', c.trigger, 'reasons', c.reasons,
         'status', json_build_array(c.goalie_status_home, c.goalie_status_away), 'conflict', c.conflict, 'gate', c.edge_gate_state,
         'basis', coalesce(c.headline ->> 'basis', 'slate'), 'model_id', c.headline ->> 'model_id',
         'p_home', c.headline -> 'p_home', 'before_p_home', c.headline -> 'before' -> 'p_home',
         'skaters', c.headline -> 'lineup' -> 'skaters',
         'probe', (select json_build_object(
                     'reads', count(*),
                     'first_listed_min', max((g ->> 'minutes_to_start')::int) filter (where (g ->> 'lineups_posted')::boolean),
                     'last_pre', (array_agg(json_build_object('min', (g ->> 'minutes_to_start')::int, 'state', g ->> 'state', 'skaters', g -> 'skaters', 'starters', (g ->> 'starters')::int)
                                            order by r.started_at desc) filter (where (g ->> 'minutes_to_start')::int >= 0))[1])
                     from public.nhl_goalie_sync_runs r
                     cross join lateral jsonb_array_elements(coalesce(r.sources -> 'nhl_api_boxscore' -> 'games', '[]'::jsonb)) g
                    where r.finished_at > c.game_start_utc - interval '4 hours' and r.finished_at < c.game_start_utc + interval '1 hour'
                      and g ->> 'game_id' = c.game_id))
       order by c.game_start_utc, c.game_id), '[]'::json)
  from public.nhl_game_cards_current c
 where c.game_start_utc < now() + interval '24 hours';
