-- ===========================================================================
-- BOOK QUOTE TICKS — a stamped history of every book's price.
--
-- Paste into the Supabase SQL editor and run. Safe to run again.
--
-- WHY
--   book_quotes holds the LATEST capture pass only: it is upserted on
--   (sig_key, book_key), so every earlier price at every book is overwritten.
--   That is why the brief record could grade only against the closing fair
--   line and the best board price, never "closed -125 at DraftKings".
--
--   This adds a trigger on book_quotes that appends every insert and every
--   changed update to book_quote_ticks with a timestamp. No change to the
--   capture function: the database records the history itself, from the
--   next capture pass onward. Nothing is backfilled, because nothing earlier
--   exists to backfill from.
--
-- THE CLOSE
--   public_brief_book_closes is the owner-run door for the grader: for every
--   signal whose game has kicked off, the LAST tick per book stamped AT OR
--   BEFORE commence_time, with how many minutes before kickoff it was seen.
--   A tick after kickoff is a live price and is never a close. The grader
--   applies its own staleness rule on lead_minutes (six hours) so a stale
--   "last quote" is reported as unqualified rather than called a close.
-- ===========================================================================

begin;

create table if not exists public.book_quote_ticks (
  id          bigserial primary key,
  sig_key     text not null,
  book_key    text,
  book_title  text,
  dec         numeric,
  fair        numeric,
  is_sharp    boolean,
  event_id    text,
  seen_at     timestamptz not null default now(),
  payload     jsonb
);
create index if not exists book_quote_ticks_sig_idx on public.book_quote_ticks (sig_key, book_key, seen_at desc);
create index if not exists book_quote_ticks_seen_idx on public.book_quote_ticks (seen_at);

-- Schema-agnostic on purpose: to_jsonb(NEW) is read by key, so a column the
-- capture build does not carry lands as null instead of breaking the trigger.
create or replace function public.book_quotes_tick()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  j jsonb := to_jsonb(NEW);
  o jsonb := case when TG_OP = 'UPDATE' then to_jsonb(OLD) else null end;
begin
  -- an update that changed nothing about the price is not a new observation
  if TG_OP = 'UPDATE' and o is not null
     and coalesce(j->>'dec','') = coalesce(o->>'dec','')
     and coalesce(j->>'fair','') = coalesce(o->>'fair','')
     and coalesce(j->>'is_sharp','') = coalesce(o->>'is_sharp','') then
    return NEW;
  end if;
  insert into public.book_quote_ticks (sig_key, book_key, book_title, dec, fair, is_sharp, event_id, seen_at, payload)
  values (
    coalesce(j->>'sig_key', ''),
    j->>'book_key',
    j->>'book_title',
    nullif(j->>'dec', '')::numeric,
    nullif(j->>'fair', '')::numeric,
    nullif(j->>'is_sharp', '')::boolean,
    j->>'event_id',
    now(),
    j
  );
  return NEW;
end;
$$;

drop trigger if exists book_quotes_tick on public.book_quotes;
create trigger book_quotes_tick
  after insert or update on public.book_quotes
  for each row execute function public.book_quotes_tick();

-- History is internal: RLS on, no public policy. Only the view below reads it out.
alter table public.book_quote_ticks enable row level security;
revoke all on public.book_quote_ticks from anon, authenticated;

-- The last pre-kickoff tick per book, for games that have kicked off.
create or replace view public.public_brief_book_closes as
  with kicked as (
    select s.sig_key, s.event_id, s.market, s.selection, s.point, s.commence_time
    from public.signals s
    where s.commence_time is not null and s.commence_time <= now()
  ),
  last_tick as (
    select distinct on (t.sig_key, t.book_key)
      t.sig_key, t.book_key, t.book_title, t.dec, t.fair, t.is_sharp, t.seen_at
    from public.book_quote_ticks t
    join kicked k on k.sig_key = t.sig_key
    where t.seen_at <= k.commence_time
    order by t.sig_key, t.book_key, t.seen_at desc
  )
  select
    k.sig_key, k.event_id, k.market, k.selection, k.point, k.commence_time,
    l.book_key, l.book_title, l.dec, l.fair, l.is_sharp, l.seen_at,
    round(extract(epoch from (k.commence_time - l.seen_at)) / 60)::integer as lead_minutes
  from kicked k
  join last_tick l on l.sig_key = k.sig_key;

alter view public.public_brief_book_closes set (security_invoker = false);
grant select on public.public_brief_book_closes to anon, authenticated;

commit;

-- Report: rows 1-3 should say ok. Row 4 counts ticks and grows from the next capture pass.
select '1 ticks table' as step,
  case when to_regclass('public.book_quote_ticks') is not null then 'ok' else 'MISSING' end as outcome
union all
select '2 trigger', case when exists (select 1 from pg_trigger where tgname = 'book_quotes_tick') then 'ok' else 'MISSING' end
union all
select '3 close view', case when to_regclass('public.public_brief_book_closes') is not null then 'ok' else 'MISSING' end
union all
select '4 ticks so far', (select count(*)::text from public.book_quote_ticks);
