-- ============================================================================
-- EdgeDesk — register college baseball with the odds gateway, DISABLED.
--
-- The college baseball model (college_baseball/, OUTCOME_VALIDATED) prices
-- every Division I game without a sportsbook. It can never be graded against
-- the market, and so can never claim value, until college baseball prices are
-- captured and archived from the first game of a season onward
-- (college_baseball/market/fetch_quotes.js; EXPERIMENTS.md, college
-- baseball). Prices cost credits. This file only makes the sport KNOWN to the
-- gateway's allowlist (supabase/odds_api_gateway.sql §1), so that turning it
-- on is one deliberate call, never a code change:
--
--   select public.odds_api_set_sport('baseball_ncaa', true);   -- authorise
--   select public.odds_api_set_sport('baseball_ncaa', false);  -- withdraw
--
-- While the row is disabled, odds_api_acquire answers `denied_sport` and
-- nothing is bought. The GitHub job additionally needs the repository
-- variable CBASE_PRICES=on (.github/workflows/college-baseball-prices.yml).
-- Expected cost when both are on: one `featured` request (h2h, spreads,
-- totals for every upcoming game) of about 3 credits, at most every 20
-- minutes of a game day, reused from the stored snapshot inside the gateway's
-- cadence window.
--
-- Idempotent: `on conflict do nothing` never re-disables a row an operator
-- enabled, and never changes its priority. Priority 5 sheds college baseball
-- first: after the NHL and the NBA (4), MMA and MLB (3), and football (1).
-- ============================================================================
insert into public.odds_api_sports (sport_key, sport_group, enabled, priority, label)
values ('baseball_ncaa', 'cbase', false, 5, 'College baseball')
on conflict (sport_key) do nothing;

-- report
select check_name, got, want, case when got = want then 'ok' else 'CHECK THIS' end as status from (
  select 'baseball_ncaa is registered' as check_name, (select count(*) from public.odds_api_sports where sport_key = 'baseball_ncaa')::text as got, '1' as want
  union all
  select 'and its state (false until authorised)', coalesce((select enabled::text from public.odds_api_sports where sport_key = 'baseball_ncaa'), 'missing'), 'false'
) r;
