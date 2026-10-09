-- =============================================================================
-- ROLLBACK: the reader funnel for EdgeDesk's own articles
-- (supabase/first_party_funnel.sql). Paste into the Supabase SQL editor.
--
-- Removes the Growth Console's report. The article_engaged event kind stays:
-- it is part of supabase/funnel.sql's registry, which lib/edgedesk_track.js
-- mirrors exactly, and its events are history. Idempotent.
-- =============================================================================
drop function if exists public.growth_admin_article_funnel(int);
notify pgrst, 'reload schema';
select 'the reader funnel report is gone' as check_name,
       case when to_regprocedure('public.growth_admin_article_funnel(integer)') is null then 'ok' else 'CHECK THIS' end as result;
