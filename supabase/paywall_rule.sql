-- ============================================================================
-- THE TERMINAL'S PAYWALL DEFERS TO THE ONE ACCESS RULE (an authorization change)
--
-- public.has_active_sub() gates the Research Terminal's data: the RLS on
-- public.signals and every view and function that asks "may this reader see
-- the book fair?" (kalshi_market_data.sql, sharp_lag.sql, radar.sql). It was
-- defined only in production, and production's copy restated the rule: it
-- read subscriptions' status itself (docs/billing-hardening.md §11 query 10;
-- Deploy Fairline's paywall check, 2026-10-29: "has_active_sub(): RESTATES
-- THE RULE"). A status-only check cannot tell what a price sells, so a Bet
-- Checker (red) or Fairline (black) subscription would read the terminal.
--
-- This replaces its body with the rule itself: a reader has the terminal when
-- one of their subscriptions rows passes billing_row_grants_access() (blue, a
-- comp, or a price never learned; never red or black). It is the definition
-- tools/billing/fairline_tier.test.js has always tested against. EdgeDesk's
-- operators keep it too, by billing_is_admin() (the business consoles' one
-- operator list): the first dry run (2026-10-29) found one account with the
-- terminal and no subscriptions row, and the owner chose to keep operators in.
--
-- CREATE OR REPLACE keeps the function's owner and its grants exactly as they
-- are: nothing here grants or revokes anything, and no policy changes.
--
-- Apply through Deploy Fairline (deploy-fairline.yml, paywall_rule = dry_run,
-- then apply). It compares every account before and after in the same
-- transaction and refuses to commit if an account would lose access the rule
-- cannot see. By hand: psql --single-transaction -f, after billing_hardening.sql.
-- Ends in a report; safe to run again.
-- ============================================================================

do $req$
begin
  if to_regprocedure('public.billing_row_grants_access(text, text, timestamptz, timestamptz)') is null
     or to_regprocedure('public.billing_is_admin()') is null then
    raise exception 'paywall_rule.sql needs supabase/billing_hardening.sql first (public.billing_row_grants_access, public.billing_is_admin)';
  end if;
end
$req$;

create or replace function public.has_active_sub()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.billing_is_admin()
      or exists (
           select 1 from public.subscriptions s
            where s.user_id = auth.uid()
              and public.billing_row_grants_access(s.status, s.price_id, s.current_period_end, now())
         );
$$;

comment on function public.has_active_sub() is
  'The Research Terminal''s gate (signals RLS and its readers): the one access rule, billing_row_grants_access(), and EdgeDesk''s operators (billing_is_admin()). supabase/paywall_rule.sql.';

-- ── report ──────────────────────────────────────────────────────────────────
select '01 has_active_sub() defers to billing_row_grants_access()' as check,
       case when pg_get_functiondef(to_regprocedure('public.has_active_sub()')) like '%billing_row_grants_access%' then 'ok' else 'CHECK THIS' end as state
union all
select '02 it names no status itself (no inlined active / trialing)',
       case when pg_get_functiondef(to_regprocedure('public.has_active_sub()')) !~* '''(active|trialing|past_due)''' then 'ok' else 'CHECK THIS' end
union all
select '03 it pins its search_path',
       case when exists (select 1 from pg_proc where oid = to_regprocedure('public.has_active_sub()')
                           and array_to_string(proconfig, ',') like 'search_path=%') then 'ok' else 'CHECK THIS' end
union all
select '04 EdgeDesk''s operators keep it (billing_is_admin())',
       case when pg_get_functiondef(to_regprocedure('public.has_active_sub()')) like '%billing_is_admin()%' then 'ok' else 'CHECK THIS' end;
