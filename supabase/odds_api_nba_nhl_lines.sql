-- ============================================================================
-- ODDS API — NBA AND NHL GAME LINES, EVERY TWO HOURS (2026-10-29)
--
-- Paste into the Supabase SQL editor and run. Safe to re-run. Every report row
-- at the bottom should say ok.
--
-- WHY. Bet Checker grades a reader's bet against EdgeDesk's fair price
-- (signals.sharp_fair, written by capture) and later against the close
-- (written by close). For the NBA and the NHL there is none: both leagues are
-- registered with the gateway DISABLED (supabase/nba_odds_sport.sql,
-- supabase/nhl_odds_sport.sql). The owner approved buying their main markets
-- on 2026-10-29 at a TWO-HOUR cadence, about 2,200 credits a month for the two
-- leagues together, instead of the hourly default (about 4,300)
-- (docs/odds-api-incident-2026-10/METHODOLOGY-2026-10-29-nba-nhl-lines.md).
--
-- WHAT IT DOES. The gateway reads a sport group's own rows in
-- public.odds_api_cadence when it has any, and the '*' rows otherwise
-- (odds_api_interval). This adds rows for the groups 'nba' and 'nhl' in the two
-- categories that buy a league's main board, `featured` (capture) and `close`
-- (close). Both ask for the same fingerprint, so both must say two hours, or
-- the one that says one hour buys hourly for both:
--      hours to the league's next start    '*' today    nba / nhl here
--      up to 3                              60 min       120 min
--      up to 24                             60 min       120 min
--      up to 72                            120 min       120 min
--      beyond                              360 min       360 min
-- Under budget pressure the gateway stretches these as it does every band.
--
-- WHAT IT DOES NOT DO.
--   - Turn either league on. The rows stay as they are (disabled unless an
--     operator enabled them). Turning them on is the owner's spend switch,
--     after the November reset (INCIDENT.md §9 step 12):
--       select public.odds_api_set_sport('basketball_nba', true);
--       select public.odds_api_set_sport('icehockey_nhl', true);
--   - Touch the breaker, the budget, any other sport's or category's cadence,
--     the hourly floor, a schedule or a job.
--   - Change a row an operator already edited (on conflict do nothing); the
--     report says CHECK THIS if one differs from the approved cadence.
-- ============================================================================

do $guard$
begin
  if to_regclass('public.odds_api_cadence') is null or to_regclass('public.odds_api_sports') is null then
    raise exception 'Apply supabase/odds_api_gateway.sql first: the sports and the purchase cadence live in its tables.';
  end if;
end $guard$;

-- ── 1. THE LEAGUES, KNOWN TO THE GATEWAY (disabled, as their own files do) ──
-- The same rows nba_odds_sport.sql and nhl_odds_sport.sql insert; a row that
-- exists, enabled or not, is left exactly as it is.
insert into public.odds_api_sports (sport_key, sport_group, enabled, priority, label) values
  ('basketball_nba', 'nba', false, 4, 'NBA'),
  ('icehockey_nhl', 'nhl', false, 4, 'NHL')
on conflict (sport_key) do nothing;

-- ── 2. THE CADENCE: two hours inside 72 h of the next start ────────────────
insert into public.odds_api_cadence (category, sport_group, max_hours_to_start, interval_minutes) values
  ('featured', 'nba', 3, 120), ('featured', 'nba', 24, 120), ('featured', 'nba', 72, 120), ('featured', 'nba', 1000000, 360),
  ('close',    'nba', 3, 120), ('close',    'nba', 24, 120), ('close',    'nba', 72, 120), ('close',    'nba', 1000000, 360),
  ('featured', 'nhl', 3, 120), ('featured', 'nhl', 24, 120), ('featured', 'nhl', 72, 120), ('featured', 'nhl', 1000000, 360),
  ('close',    'nhl', 3, 120), ('close',    'nhl', 24, 120), ('close',    'nhl', 72, 120), ('close',    'nhl', 1000000, 360)
on conflict (category, sport_group, max_hours_to_start) do nothing;

-- ── report ──────────────────────────────────────────────────────────────────
select check_name, got, want, case when got = want then 'ok' else 'CHECK THIS' end as status from (
  select 'basketball_nba is registered in group nba' as check_name,
         (select count(*) from public.odds_api_sports where sport_key = 'basketball_nba' and sport_group = 'nba')::text as got, '1' as want
  union all
  select 'icehockey_nhl is registered in group nhl',
         (select count(*) from public.odds_api_sports where sport_key = 'icehockey_nhl' and sport_group = 'nhl')::text, '1'
  union all
  select 'nba ' || c || ', next start ' || h || ' h away: minutes between purchases',
         coalesce(public.odds_api_interval(c, 'nba', h) ->> 'interval', 'none'), w
    from (values ('featured', 1, '120'), ('featured', 10, '120'), ('featured', 48, '120'), ('featured', 200, '360'),
                 ('close', 1, '120'), ('close', 10, '120'), ('close', 48, '120'), ('close', 200, '360')) v(c, h, w)
  union all
  select 'nhl ' || c || ', next start ' || h || ' h away: minutes between purchases',
         coalesce(public.odds_api_interval(c, 'nhl', h) ->> 'interval', 'none'), w
    from (values ('featured', 1, '120'), ('featured', 10, '120'), ('featured', 48, '120'), ('featured', 200, '360'),
                 ('close', 1, '120'), ('close', 10, '120'), ('close', 48, '120'), ('close', 200, '360')) v(c, h, w)
  union all
  select 'football is unchanged: nfl featured inside 3 h',
         coalesce(public.odds_api_interval('featured', 'nfl', 1) ->> 'interval', 'none'), '60'
) r;
-- Information, not a check: whether each league is switched on yet.
select sport_key, enabled, priority from public.odds_api_sports where sport_key in ('basketball_nba', 'icehockey_nhl') order by sport_key;
