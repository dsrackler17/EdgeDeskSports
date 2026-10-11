-- =============================================================================
-- research_packets_views_rls — the per-row research_packets views read under
-- the CALLER's rights (2026-10-11).
--
-- WHAT WAS WRONG
--   research_packet_grades and research_packet_pricing were created without
--   security_invoker. A view owned by postgres runs with its owner's rights,
--   so the row level security on research_packets (a reader sees their own
--   packets) did not apply through them: any signed-in reader, and under
--   Supabase's default grants the public anon key, could read every reader's
--   packets, questions, selections and prices by selecting from the view.
--   Reproduced on PostgreSQL 16 by
--   tools/intelligence/research_packets_rls_sql.test.js.
--
-- WHAT THIS DOES (and nothing else)
--   1. Both per-row views run with the caller's rights: a reader sees only
--      their own packets through them, exactly as through the table.
--   2. anon loses every privilege on the three views. Nothing in EdgeDesk
--      reads them with the public key; the only reader is the learning loop,
--      which uses the service role (BYPASSRLS) and is unaffected.
--   research_packet_calibration aggregates the grades view, so from now on a
--   signed-in reader's calibration covers their own packets and the service
--   role's covers every packet. It carries no reader id and no packet id.
--
-- The same change is in supabase/research_packets.sql for a fresh database;
-- this file is the small one to paste into a database that already has the
-- views. Idempotent, additive, no psql meta-commands, ends in a report.
-- Rollback: supabase/research_packets_views_rls_rollback.sql.
-- =============================================================================

do $dep$ begin
  if to_regclass('public.research_packet_grades') is null or to_regclass('public.research_packet_pricing') is null then
    raise exception 'apply supabase/research_packets.sql first';
  end if;
end $dep$;

alter view public.research_packet_grades set (security_invoker = true);
alter view public.research_packet_pricing set (security_invoker = true);

do $anon$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.research_packet_grades from anon;
    revoke all on public.research_packet_calibration from anon;
    revoke all on public.research_packet_pricing from anon;
  end if;
end $anon$;
grant select on public.research_packet_grades to authenticated;
grant select on public.research_packet_pricing to authenticated;
grant select on public.research_packet_calibration to authenticated;

notify pgrst, 'reload schema';

select 'grades view runs with the caller''s rights' as piece,
       case when (select reloptions @> array['security_invoker=true'] from pg_class where oid = 'public.research_packet_grades'::regclass) then 'ok' else 'CHECK THIS' end as state
union all
select 'pricing view runs with the caller''s rights',
       case when (select reloptions @> array['security_invoker=true'] from pg_class where oid = 'public.research_packet_pricing'::regclass) then 'ok' else 'CHECK THIS' end
union all
select 'anon holds no privilege on the three views',
       case when not exists (select 1 from pg_roles where rolname = 'anon')
             or (not has_table_privilege('anon', 'public.research_packet_grades', 'select')
             and not has_table_privilege('anon', 'public.research_packet_pricing', 'select')
             and not has_table_privilege('anon', 'public.research_packet_calibration', 'select')) then 'ok' else 'CHECK THIS' end;
