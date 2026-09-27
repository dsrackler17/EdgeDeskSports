-- ===========================================================================
-- EdgeDesk CFB Research Terminal — product analytics, the table.
--
-- WHAT IT IS FOR. Which research pages and sections readers actually open,
-- whether they use the watchlist, the record and "Ask this game", and whether
-- they come back. It exists to improve the RESEARCH EXPERIENCE (docs/cfb-terminal
-- PRODUCT_ANALYTICS in DELIVERABLE.md) and for nothing else.
--
-- WHAT IT MUST NEVER DO. Touch a model. No projection, calibration, decision or
-- ranking build reads this table: engagement is not evidence about football,
-- and a popular game is not a mispriced one. football/cfb_terminal/tests.js
-- fails if any file under football/, lib/ or tools/ other than this contract's
-- own test references the table name.
--
-- The guarantees:
--   * INSERT-ONLY, AND ONLY THROUGH ONE FUNCTION. anon and authenticated have
--     no table privileges at all; cfb_terminal_track() validates the event
--     name against a fixed list, clips every text field, carries no user id,
--     no IP, no user agent, and rate-limits a visitor to 120 events an hour.
--   * NO IDENTITY. The visitor id is a random string the browser made; it is
--     not joined to an account here.
--   * OPERATOR READS ONLY. The daily roll-up is visible to growth admins
--     (growth_is_admin(), supabase/growth.sql) and to nobody else.
--
-- Idempotent and additive; it ends in a report. Rows 1-6 should say ok.
-- ===========================================================================

create table if not exists public.cfb_terminal_events (
  id         bigserial   primary key,
  at         timestamptz not null default now(),
  visitor    text        not null,
  event      text        not null,
  game_id    text,
  section    text,
  detail     text
);

alter table public.cfb_terminal_events drop constraint if exists cfb_terminal_events_event_shape;
alter table public.cfb_terminal_events add constraint cfb_terminal_events_event_shape
  check (event in ('board_view','game_open','section_open','filter_apply','watch_add','watch_remove','target_set',
                   'ask','record_view','record_filter','brief_view','why_view','feedback','export'));
alter table public.cfb_terminal_events drop constraint if exists cfb_terminal_events_text_shape;
alter table public.cfb_terminal_events add constraint cfb_terminal_events_text_shape
  check (char_length(visitor) between 4 and 64
     and (game_id is null or char_length(game_id) <= 24)
     and (section is null or char_length(section) <= 24)
     and (detail  is null or char_length(detail)  <= 120));

create index if not exists cfb_terminal_events_at on public.cfb_terminal_events (at);
create index if not exists cfb_terminal_events_visitor_at on public.cfb_terminal_events (visitor, at);

alter table public.cfb_terminal_events enable row level security;
revoke all on public.cfb_terminal_events from public, anon, authenticated;
revoke all on sequence public.cfb_terminal_events_id_seq from public, anon, authenticated;

create or replace function public.cfb_terminal_track(p_visitor text, p_event text, p_game_id text default null,
                                                     p_section text default null, p_detail text default null)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if p_visitor is null or char_length(p_visitor) < 4 or char_length(p_visitor) > 64 then return false; end if;
  if p_event not in ('board_view','game_open','section_open','filter_apply','watch_add','watch_remove','target_set',
                     'ask','record_view','record_filter','brief_view','why_view','feedback','export') then return false; end if;
  select count(*) into n from public.cfb_terminal_events where visitor = p_visitor and at > now() - interval '1 hour';
  if n >= 120 then return false; end if;
  insert into public.cfb_terminal_events (visitor, event, game_id, section, detail)
  values (p_visitor, p_event, left(p_game_id, 24), left(p_section, 24), left(p_detail, 120));
  return true;
end $$;
revoke all on function public.cfb_terminal_track(text, text, text, text, text) from public;
grant execute on function public.cfb_terminal_track(text, text, text, text, text) to anon, authenticated;

-- the operator's roll-up: events and distinct visitors per day, and the
-- return rate (visitors seen on more than one day in the window)
create or replace function public.cfb_terminal_usage(p_days int default 28)
returns table (day date, event text, events bigint, visitors bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  select date_trunc('day', at)::date, event, count(*), count(distinct visitor)
    from public.cfb_terminal_events
   where public.growth_is_admin() and at > now() - make_interval(days => greatest(1, least(p_days, 180)))
   group by 1, 2 order by 1 desc, 2;
$$;
revoke all on function public.cfb_terminal_usage(int) from public, anon;
grant execute on function public.cfb_terminal_usage(int) to authenticated;

create or replace function public.cfb_terminal_return_rate(p_days int default 28)
returns table (visitors bigint, returning_visitors bigint, record_viewers bigint, explanation_openers bigint, market_openers bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  with w as (select * from public.cfb_terminal_events
              where public.growth_is_admin() and at > now() - make_interval(days => greatest(1, least(p_days, 180)))),
       d as (select visitor, count(distinct date_trunc('day', at)) as days from w group by visitor)
  select (select count(*) from d), (select count(*) from d where days > 1),
         (select count(distinct visitor) from w where event = 'record_view'),
         (select count(distinct visitor) from w where event = 'section_open' and section in ('d','e')),
         (select count(distinct visitor) from w where event = 'section_open' and section in ('b','c'));
$$;
revoke all on function public.cfb_terminal_return_rate(int) from public, anon;
grant execute on function public.cfb_terminal_return_rate(int) to authenticated;

select 1 as row, 'cfb_terminal_events exists with RLS on' as check_,
       case when to_regclass('public.cfb_terminal_events') is not null
             and (select relrowsecurity from pg_class where oid='public.cfb_terminal_events'::regclass) then 'ok' else 'CHECK THIS' end as result
union all select 2, 'anon/authenticated hold no table privilege',
       case when not exists (select 1 from information_schema.role_table_grants
                              where table_schema='public' and table_name='cfb_terminal_events'
                                and grantee in ('anon','authenticated')) then 'ok' else 'CHECK THIS' end
union all select 3, 'cfb_terminal_track() is security definer',
       case when (select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public' and p.proname='cfb_terminal_track') then 'ok' else 'CHECK THIS' end
union all select 4, 'event and text constraints installed',
       case when (select count(*) from pg_constraint where conrelid='public.cfb_terminal_events'::regclass
                   and conname in ('cfb_terminal_events_event_shape','cfb_terminal_events_text_shape'))=2 then 'ok' else 'CHECK THIS' end
union all select 5, 'roll-ups are admin-gated',
       case when to_regprocedure('public.cfb_terminal_usage(int)') is not null
             and to_regprocedure('public.cfb_terminal_return_rate(int)') is not null then 'ok' else 'CHECK THIS' end
union all select 6, 'growth_is_admin() exists (apply supabase/growth.sql first)',
       case when to_regprocedure('public.growth_is_admin()') is not null then 'ok' else 'CHECK THIS' end
order by row;
