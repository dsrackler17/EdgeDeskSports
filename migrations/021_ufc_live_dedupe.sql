-- ============================================================================
-- 021_ufc_live_dedupe.sql — one-time cleanup for duplicated live fight rows.
--
-- WHY: ufc_live used to build fight_id from fighter-name slugs and now uses
-- ESPN's competition id. Upsert keys on fight_id, so the new rows were inserted
-- alongside the old ones instead of replacing them and every fight rendered
-- twice. The same thing happens to a bout that gets replaced late on a card.
--
-- The poller now reconciles each card after every run (it deletes rows for the
-- event that were not in that run's payload), so this only has to be run once,
-- to clear what accumulated before that shipped.
--
-- Safe to run more than once. Read the SELECT first, then run the DELETE.
-- ============================================================================

-- 1) LOOK FIRST — which events currently hold duplicate pairings?
select event_id,
       lower(coalesce(red_name,'')) || ' vs ' || lower(coalesce(blue_name,'')) as pairing,
       count(*)                as rows,
       min(updated_at)         as oldest_write,
       max(updated_at)         as newest_write,
       string_agg(fight_id, ' | ' order by updated_at desc) as fight_ids
  from ufc.live_fights
 group by 1, 2
having count(*) > 1
 order by rows desc, event_id;

-- 2) DELETE the superseded copies: for each (event, pairing) keep only the most
--    recently written row. Ties broken by fight_id so the choice is stable.
with ranked as (
  select fight_id,
         row_number() over (
           partition by event_id,
                        lower(coalesce(red_name,'')),
                        lower(coalesce(blue_name,''))
           order by updated_at desc nulls last, fight_id desc
         ) as rn
    from ufc.live_fights
)
delete from ufc.live_fights f
 using ranked r
 where f.fight_id = r.fight_id
   and r.rn > 1;

-- 3) Orphans: fight rows whose event no longer exists at all.
delete from ufc.live_fights f
 where not exists (select 1 from ufc.live_events e where e.event_id = f.event_id);

-- 4) VERIFY — both queries should return zero rows.
select 'duplicate pairings remaining' as check, count(*) as rows from (
  select 1 from ufc.live_fights
   group by event_id, lower(coalesce(red_name,'')), lower(coalesce(blue_name,''))
  having count(*) > 1) d
union all
select 'fights with no event', count(*) from ufc.live_fights f
 where not exists (select 1 from ufc.live_events e where e.event_id = f.event_id);

-- 5) While you are here: events the old status bug may have left open.
--    ("final" contains "in", so finished cards were written as status 'in'.)
--    The poller closes these automatically now; this just shows what is left.
select event_id, name, status, start_time, updated_at
  from ufc.live_events
 where status <> 'post'
   and start_time < now() - interval '12 hours'
 order by start_time desc;
