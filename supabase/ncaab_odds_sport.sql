-- ============================================================================
-- EdgeDesk — register men's college basketball (NCAAB) with the odds gateway,
-- DISABLED (2026-11-01).
--
-- Two men's college basketball research models price games without any
-- sportsbook price: NCAAM-FORECAST (basketball/ncaam_forecast, on main) and the
-- early-season model NCAAM-EARLY being built (basketball/ncaam_early). Neither
-- can be graded against the market, or show a market comparison, until NCAAB
-- prices are captured and archived from the first game of the season onward
-- (CBB_MODEL_NOTES.md §2: "no NCAAM market is captured"). Prices cost credits.
-- This file only makes the sport KNOWN to the gateway's allowlist
-- (supabase/odds_api_gateway.sql §1), so that turning it on is one deliberate
-- call, never a code change:
--
--   select public.odds_api_set_sport('basketball_ncaab', true);   -- authorise
--   select public.odds_api_set_sport('basketball_ncaab', false);  -- withdraw
--
-- While the row is disabled, odds_api_acquire answers `denied_sport` and
-- nothing is bought.
--
-- CADENCE: none is added. The group 'ncaab' has no rows of its own in
-- public.odds_api_cadence, so the gateway applies the '*' bands (60 minutes
-- inside 24 h of the next start, 120 to 72 h, 360 beyond), the same as
-- football. Capture's `featured` and close's `close` share one fingerprint, so
-- the whole board (h2h, spreads, totals for every listed game) is one request
-- of about 3 credits whatever the number of games: at most 24 buys a day,
-- about 2,160 credits a month in season. The owner approved about 2,000 a
-- month on 2026-11-01
-- (docs/odds-api-incident-2026-10/METHODOLOGY-2026-11-01-ncaab-lines.md).
--
-- WHAT IT DOES NOT DO: turn the sport on; touch the breaker, the budget, the
-- categories, another sport's row or any cadence row; schedule or change a
-- job. Capture asks for a sport only when CAPTURE_SPORTS (a Supabase function
-- secret, not in this repository) names it; adding basketball_ncaab there is
-- the second step of the switch-on (the methodology note, step 3).
--
-- Idempotent: `on conflict do nothing` never re-disables a row an operator
-- enabled, and never changes its priority. Priority 4 sheds NCAAB with the NBA
-- and the NHL (4): after MMA and MLB (3) and football (1), before college
-- baseball (5).
-- ============================================================================

do $guard$
begin
  if to_regclass('public.odds_api_sports') is null or to_regprocedure('public.odds_api_interval(text,text,numeric)') is null then
    raise exception 'Apply supabase/odds_api_gateway.sql first: the sports allowlist and the purchase cadence live in its tables.';
  end if;
end $guard$;

insert into public.odds_api_sports (sport_key, sport_group, enabled, priority, label)
values ('basketball_ncaab', 'ncaab', false, 4, 'NCAAB (men''s college basketball)')
on conflict (sport_key) do nothing;

-- report
select check_name, got, want, case when got = want then 'ok' else 'CHECK THIS' end as status from (
  select 'basketball_ncaab is registered in group ncaab' as check_name,
         (select count(*) from public.odds_api_sports where sport_key = 'basketball_ncaab' and sport_group = 'ncaab')::text as got, '1' as want
  union all
  select 'and its priority (sheds with the NBA and the NHL)',
         coalesce((select priority::text from public.odds_api_sports where sport_key = 'basketball_ncaab'), 'missing'), '4'
  union all
  select 'the group has no cadence rows of its own (the ''*'' bands apply)',
         (select count(*) from public.odds_api_cadence where sport_group = 'ncaab')::text, '0'
  union all
  select 'ncaab ' || c || ', next start ' || h || ' h away: minutes between purchases',
         coalesce(public.odds_api_interval(c, 'ncaab', h) ->> 'interval', 'none'), w
    from (values ('featured', 1, '60'), ('featured', 10, '60'), ('featured', 48, '120'), ('featured', 200, '360'),
                 ('close', 1, '60'), ('close', 10, '60'), ('close', 48, '120'), ('close', 200, '360')) v(c, h, w)
) r;
-- Information, not a check: whether the sport is switched on yet (false until the owner authorises it).
select sport_key, enabled, priority from public.odds_api_sports where sport_key = 'basketball_ncaab';
