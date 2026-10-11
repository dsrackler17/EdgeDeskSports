-- =============================================================================
-- ROLLBACK of supabase/research_packets_views_rls.sql.
--
-- Restores the previous owner-rights definition of the two per-row views.
-- READ THIS FIRST: that definition is the defect the patch fixed — through
-- these views a signed-in reader can read every reader's packets again. Run
-- it only if the patch broke something that cannot wait (nothing in the
-- repository reads these views except the service-role learning loop, which
-- BYPASSRLS makes indifferent to the change), and re-apply the patch after.
--
-- The anon revokes are NOT undone: no EdgeDesk surface reads these views
-- with the public key, so removing anon's access cannot break anything, and
-- restoring it would only reopen the views to the public key.
-- Idempotent, no psql meta-commands, ends in a report.
-- =============================================================================

alter view if exists public.research_packet_grades reset (security_invoker);
alter view if exists public.research_packet_pricing reset (security_invoker);

notify pgrst, 'reload schema';

select 'grades view back to owner rights' as piece,
       case when coalesce((select not (coalesce(reloptions, '{}') @> array['security_invoker=true']) from pg_class where oid = 'public.research_packet_grades'::regclass), true) then 'ok' else 'CHECK THIS' end as state
union all
select 'pricing view back to owner rights',
       case when coalesce((select not (coalesce(reloptions, '{}') @> array['security_invoker=true']) from pg_class where oid = 'public.research_packet_pricing'::regclass), true) then 'ok' else 'CHECK THIS' end;
