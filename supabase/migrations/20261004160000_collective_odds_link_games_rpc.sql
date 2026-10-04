-- Make the linker the odds ingest function actually calls resolve.
--
-- collective_odds_ingest ends every run with
--
--   POST /rest/v1/rpc/odds_link_games   { "p_league": "ncaaf" }
--   Content-Profile: collective
--
-- so PostgREST resolves `collective.odds_link_games(p_league text)`. Nothing
-- created that. The linker that exists is `odds.link_collective_games`, from
-- 20260922220100_fix_ncaaf_collective_game_linking.sql — a different name in a
-- different schema.
--
-- The consequence is quiet, which is why it survived a season. On /v1/ingest
-- the call is wrapped in `.catch(() => 0)`, so a name that does not resolve and
-- a week with no new matches are indistinguishable: both report
-- `games_linked: 0` next to `status: "ok"`. Nothing is logged and the run looks
-- clean. Downstream, odds.events.collective_game_id stays null, so no settled
-- CFB game can inherit a captured closing spread and ATS grading has nothing to
-- grade against. (/v1/link and /v1/close make the same call uncaught, so those
-- two surface it as a 500 — see the verification below.)
--
-- This adds the name as a thin wrapper rather than changing the edge function,
-- because the function is deployed by pasting a bundle into the dashboard and
-- the copy in this repository is a reconstruction of it. One SQL statement is
-- the smaller, more reversible fix, and it leaves the deployed bundle alone.
--
-- The wrapper adds no behaviour: same argument, same integer return, same
-- swallow-and-return-zero contract as the linker it delegates to.

create or replace function collective.odds_link_games(p_league text default 'nfl')
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_linked int := 0;
begin
  -- Applied against a database where the odds schema has not been built yet,
  -- this returns 0 rather than failing: the wrapper exists, there is simply
  -- nothing behind it yet, and the next apply picks the linker up.
  if to_regprocedure('odds.link_collective_games(text)') is null then
    raise notice 'collective.odds_link_games: odds.link_collective_games(text) is absent, nothing linked';
    return 0;
  end if;

  execute 'select odds.link_collective_games($1)'
    into v_linked
    using p_league;

  return coalesce(v_linked, 0);
end;
$function$;

comment on function collective.odds_link_games(text) is
  'Delegates to odds.link_collective_games. Exists because collective_odds_ingest calls this name over PostgREST with Content-Profile: collective.';

-- Least privilege. Only the service-role key reaches this: the ingest function
-- holds that key, and the linker it fronts writes to odds.events.
revoke all on function collective.odds_link_games(text) from public;
revoke all on function collective.odds_link_games(text) from anon;
revoke all on function collective.odds_link_games(text) from authenticated;
grant execute on function collective.odds_link_games(text) to service_role;

-- Already true on this project — the service key reaches collective.odds_set_setting
-- today — but stated so the migration stands on its own. Without schema usage the
-- EXECUTE grant above is unreachable and the call fails with "permission denied for
-- schema collective" rather than anything that mentions the function.
grant usage on schema collective to service_role;

-- PostgREST caches the schema it exposes; without this the new name keeps
-- 404ing with PGRST202 until the connection pool turns over.
notify pgrst, 'reload schema';

-- Verification, after applying:
--
--   select collective.odds_link_games('ncaaf');   -- an integer, not an error
--
-- and through the API, which is the path that was broken:
--
--   curl -sS -X POST "$SB_URL/functions/v1/collective_odds_ingest/v1/link?league=ncaaf" \
--     -H "Authorization: Bearer $SERVICE_KEY"
--
-- That route calls the same RPC uncaught. Before this migration it answers
-- with a PGRST202 "Could not find the function" body; after it, with
-- {"ok":true,"league":"ncaaf","games_linked":N}. A non-zero N on the first run
-- is the backlog this had been dropping. Then confirm the linkage landed:
--
--   select count(*) filter (where collective_game_id is not null) as linked,
--          count(*) as events
--     from odds.events where league = 'ncaaf';
