-- ==========================================================================
-- EdgeDesk — SHIP-GATE REMEDIATION (run in the Supabase SQL editor)
--
-- Closes the confirmed P0/P1 access-control holes found by the live catalog
-- audit (query [A] execute-grant dump + the RLS/grants dump).
--
-- SAFE TO APPLY: the frontend makes NO direct /rest/v1/rpc/ calls (verified);
-- every one of these functions is invoked only by Edge Functions, which use the
-- SERVICE ROLE and are unaffected by revoking anon/authenticated. has_active_sub
-- is deliberately LEFT ALONE — RLS policies call it as the authenticated user.
--
-- Run it as one transaction; re-running is harmless (REVOKE is idempotent).
-- ==========================================================================
begin;

-- ── P0 #1 — public.edge_call hands out the vault service-role key + cron secret
--            to ANY caller and has no auth check. anon/authenticated can invoke
--            every privileged Edge Function (settle/close/ingest/AI) at will.
revoke execute on function public.edge_call(text, jsonb, integer, text)
  from anon, authenticated, public;

-- ── P0 #2 — collective.get_config/cfg* leak collective.config (incl.
--            admin.user_ids) to anon, which defeats every is_admin(p_admin) check.
-- ── P0 #3 — settle_game/mint_invite/upsert_games authorize on a CLIENT-SUPPLIED
--            p_admin; with the leaked admin uid they become fully callable.
-- ── P0 #4 — billing_upsert_subscriber/billing_post_invoice/billing_post_refund
--            have NO auth check and write collective.subscribers + earnings_ledger
--            (forge an active collective sub, manipulate the payout ledger).
-- ── P1    — admin_resolve_quarantine/admin_reresolve/grade_game/ingest_submission
--            let anon forge/resolve/grade collective projections.
-- Every collective RPC is meant to be called only by the Collective Edge
-- Functions (service role). Revoke the whole schema from the client roles.
revoke execute on all functions in schema collective from anon, authenticated;

-- Stop the same default from re-granting execute on FUTURE collective functions.
-- (Adjust the role after IN SCHEMA if your objects are owned by a different role.)
alter default privileges in schema collective
  revoke execute on functions from anon, authenticated;

-- ── P2 — public SECURITY DEFINER helpers that mutate shared state with no auth.
revoke execute on function public.guarantee_sweep()                                             from anon, authenticated, public;
revoke execute on function public.research_set_status(uuid, text, text)                          from anon, authenticated, public;
revoke execute on function public.research_rebuild_patterns(integer)                             from anon, authenticated, public;
revoke execute on function public.research_register_validation(uuid, integer, numeric, jsonb, boolean) from anon, authenticated, public;
revoke execute on function public.research_complete_validation(uuid, integer, numeric, numeric)  from anon, authenticated, public;

-- ── P1 — three financial VIEWS are SELECTable by anon and run as owner
--         (bypassing RLS on ai_usage / subscriptions / guarantee_windows /
--         referrals). Lock them to server-side (service_role / SQL editor) reads.
revoke all on public.ai_cost_per_user     from anon, authenticated;
revoke all on public.guarantee_refunds_due from anon, authenticated;
revoke all on public.partner_rollup       from anon, authenticated;

commit;

-- ── VERIFY (should now list ONLY postgres= and service_role= for each) ──────
-- SELECT n.nspname, p.proname, array_to_string(p.proacl, E'\n')
-- FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
-- WHERE p.proname IN ('edge_call','settle_game','mint_invite','upsert_games',
--   'get_config','billing_upsert_subscriber','ingest_submission','grade_game',
--   'admin_resolve_quarantine','guarantee_sweep','research_set_status')
-- ORDER BY 1,2;

-- ==========================================================================
-- P1 (product decision, NOT included above — apply once you decide free vs paid):
-- these are readable without a subscription while model_predictions is paywalled.
-- To gate them like signals/model_predictions, drop the open policy and add:
--
--   DROP POLICY model_props_read       ON public.model_props;
--   CREATE POLICY model_props_paid ON public.model_props FOR SELECT
--     TO authenticated USING (public.has_active_sub());
--   -- repeat for: model_odds, model_conf_signals, model_ratings, model_perf,
--   --             model_golf, game_projections, team_briefs, boards (as desired)
--
-- Also set on the CLV side (config, not SQL): CLOSE_REQUIRE_SHARP=true, or have
-- the Record page average CLV only over rows where closing_has_sharp = true.
-- ==========================================================================
