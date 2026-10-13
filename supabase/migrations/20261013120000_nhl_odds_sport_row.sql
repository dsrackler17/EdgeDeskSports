-- ============================================================================
-- EdgeDesk — register the NHL with the odds gateway, DISABLED.
--
-- The NHL brain (hockey/, docs/engine/NHL.md) prices every NHL game without a
-- sportsbook. Comparing those prices with books needs NHL prices, and NHL
-- prices cost credits. This file only makes the sport KNOWN to the gateway's
-- allowlist (supabase/odds_api_gateway.sql §1) so that turning it on is one
-- deliberate call, never a code change:
--
--   select public.odds_api_set_sport('icehockey_nhl', true);   -- authorise
--   select public.odds_api_set_sport('icehockey_nhl', false);  -- withdraw
--
-- While the row is disabled, odds_api_acquire answers `denied_sport` and
-- nothing is bought. The GitHub job additionally needs the repository
-- variable NHL_PRICES=on (hockey/market/fetch_quotes.js). Expected cost when
-- both are on: one `featured` request (h2h, spreads, totals) ≈ 3 credits,
-- reused from the stored snapshot inside the gateway's cadence window.
--
-- Idempotent: `on conflict do nothing` never re-disables a row an operator
-- enabled, and never changes its priority. Priority 4 sheds NHL before
-- football (1) and before MMA/MLB (3).
-- ============================================================================
insert into public.odds_api_sports (sport_key, sport_group, enabled, priority, label)
values ('icehockey_nhl', 'nhl', false, 4, 'NHL')
on conflict (sport_key) do nothing;

-- report
select check_name, got, want, case when got = want then 'ok' else 'CHECK THIS' end as status from (
  select 'icehockey_nhl is registered' as check_name, (select count(*) from public.odds_api_sports where sport_key = 'icehockey_nhl')::text as got, '1' as want
  union all
  select 'and its state (false until authorised)', coalesce((select enabled::text from public.odds_api_sports where sport_key = 'icehockey_nhl'), 'missing'), 'false'
) r;
