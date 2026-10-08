-- =============================================================================
-- ROLLBACK: the reader funnel for EdgeDesk's own articles
-- (supabase/first_party_funnel.sql). Paste into the Supabase SQL editor.
--
-- Removes the Growth Console's report. The article_engaged event kind is
-- removed only if no event uses it; otherwise it is kept (events are history,
-- and user_events references the registry), and lib/edgedesk_public.js simply
-- stops being able to record new ones once the kind is gone. Idempotent.
-- =============================================================================
drop function if exists public.growth_admin_article_funnel(int);
do $k$
begin
  if not exists (select 1 from public.user_events where event_name = 'article_engaged') then
    delete from public.user_event_kinds where event_name = 'article_engaged';
  else
    raise notice 'article_engaged events exist: the event kind is kept (history); no new ones are counted by the Growth Console';
  end if;
end
$k$;
notify pgrst, 'reload schema';
select 'the reader funnel report is gone' as check_name,
       case when to_regprocedure('public.growth_admin_article_funnel(integer)') is null then 'ok' else 'CHECK THIS' end as result;
