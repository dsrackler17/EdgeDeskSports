-- portfolio_decision -- part 3 of 9.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. THE MARKET PATH — append-only; written by the database, never typed
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.portfolio_market_path (
  id            bigint      generated always as identity primary key,
  position_id   uuid        not null,
  user_id       uuid        not null references auth.users(id) on delete cascade,
  kind          text        not null,
  observed_at   timestamptz not null,
  time_basis    text        not null,
  source        text        not null,
  book          text        null,
  odds_decimal  numeric     null,
  price         numeric     null,
  line          numeric     null,
  recorded_at   timestamptz not null default now(),
  constraint portfolio_path_position_fk foreign key (position_id, user_id)
    references public.portfolio_positions (id, user_id) on delete cascade,
  constraint portfolio_path_kind check (kind in ('OPEN', 'DECISION', 'RESEARCH', 'ENTRY', 'QUOTE', 'CLOSE')),
  constraint portfolio_path_time check (time_basis in ('OBSERVED', 'RECORDED')),
  constraint portfolio_path_source check (source in ('EDGEDESK_SNAPSHOT', 'USER', 'PLATFORM', 'EDGEDESK_CAPTURE', 'book_quote_ticks')),
  constraint portfolio_path_values check ((odds_decimal is null or (odds_decimal > 1 and odds_decimal <= 10001))
    and (price is null or price between 0 and 1) and (line is null or abs(line) <= 1000)
    and coalesce(odds_decimal, price, line) is not null and coalesce(length(book), 0) <= 60)
);
comment on table public.portfolio_market_path is
  'APPEND-ONLY. Prices observed for a position between the decision and the close, each with its source and whether its time was OBSERVED (a capture time) or only RECORDED (when EdgeDesk learned it). Written by the database from the snapshot, the journal and legitimate feeds; never typed by a reader.';
create unique index if not exists portfolio_path_once
  on public.portfolio_market_path (position_id, kind, source, observed_at, coalesce(book, ''));
create index if not exists portfolio_path_user on public.portfolio_market_path (user_id, position_id, observed_at);

create or replace function public.portfolio_path_guard() returns trigger
language plpgsql as $$
begin
  raise exception 'portfolio: a market path point is never rewritten' using errcode = '42501';
end $$;
drop trigger if exists portfolio_path_guard_trg on public.portfolio_market_path;
create trigger portfolio_path_guard_trg before update on public.portfolio_market_path
  for each row execute function public.portfolio_path_guard();

-- the decision price (the snapshot's market, at its capture time) and the
-- entry price (the position's own, at its placed time)
create or replace function public.portfolio_path_from_snapshot(p_position uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare s record; p record;
begin
  select * into s from public.portfolio_decision_snapshots where position_id = p_position;
  select * into p from public.portfolio_positions where id = p_position;
  /* a reader reaches this only for their own position */
  if p.id is null or (auth.uid() is not null and p.user_id <> auth.uid()) then return; end if;
  if s.position_id is not null and s.user_id = p.user_id and (s.market->>'captured_at') is not null
     and coalesce(s.market->>'odds_decimal', s.market->>'price', s.market->>'line') is not null then
    insert into public.portfolio_market_path (position_id, user_id, kind, observed_at, time_basis, source, book, odds_decimal, price, line)
    values (p.id, p.user_id, 'DECISION', (s.market->>'captured_at')::timestamptz, 'OBSERVED', 'EDGEDESK_SNAPSHOT', s.market->>'book',
            (s.market->>'odds_decimal')::numeric, (s.market->>'price')::numeric, (s.market->>'line')::numeric)
    on conflict do nothing;
  end if;
  if coalesce(p.odds_decimal, p.average_entry_price, p.line) is not null then
    insert into public.portfolio_market_path (position_id, user_id, kind, observed_at, time_basis, source, book, odds_decimal, price, line)
    values (p.id, p.user_id, 'ENTRY', p.placed_at, 'OBSERVED', case when p.source = 'SYNC' then 'PLATFORM' else 'USER' end, p.platform,
            case when p.platform_type = 'SPORTSBOOK' then p.odds_decimal end,
            case when p.platform_type = 'PREDICTION_MARKET' then p.average_entry_price end, p.line)
    on conflict do nothing;
  end if;
end $$;

-- the journal's opening, research and closing prices, as they are recorded.
-- An opening or closing price typed by a reader has no observation time: it
-- is stamped with when it was RECORDED and says so.
create or replace function public.portfolio_path_from_journal() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare p record; o jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
begin
  select id, user_id, platform, platform_type, line into p from public.portfolio_positions where id = new.position_id;
  if p.id is null then return null; end if;
  if coalesce(new.opening_odds_decimal, new.opening_price, new.opening_line) is not null
     and coalesce(o->>'opening_odds_decimal', o->>'opening_price', o->>'opening_line') is null then
    insert into public.portfolio_market_path (position_id, user_id, kind, observed_at, time_basis, source, odds_decimal, price, line)
    values (p.id, p.user_id, 'OPEN', coalesce(new.decision_recorded_at, now()), 'RECORDED', 'USER',
            case when p.platform_type = 'SPORTSBOOK' then new.opening_odds_decimal end, case when p.platform_type = 'PREDICTION_MARKET' then new.opening_price end,
            new.opening_line)
    on conflict do nothing;
  end if;
  /* a researched price that IS the snapshot's (filled from it, same capture
     time) is already on the path as the decision price: not listed twice */
  if coalesce(new.research_odds_decimal, new.research_price, new.research_line) is not null
     and coalesce(o->>'research_odds_decimal', o->>'research_price', o->>'research_line') is null
     and not exists (select 1 from public.portfolio_decision_snapshots s where s.position_id = p.id
                       and (s.market->>'captured_at')::timestamptz is not distinct from new.research_at) then
    insert into public.portfolio_market_path (position_id, user_id, kind, observed_at, time_basis, source, odds_decimal, price, line)
    values (p.id, p.user_id, 'RESEARCH', coalesce(new.research_at, new.research_recorded_at, now()),
            case when new.research_at is not null then 'OBSERVED' else 'RECORDED' end,
            'USER',
            case when p.platform_type = 'SPORTSBOOK' then new.research_odds_decimal end, case when p.platform_type = 'PREDICTION_MARKET' then new.research_price end,
            new.research_line)
    on conflict do nothing;
  end if;
  if coalesce(new.closing_odds_decimal, new.closing_price, new.closing_line) is not null
     and coalesce(o->>'closing_odds_decimal', o->>'closing_price', o->>'closing_line') is null then
    insert into public.portfolio_market_path (position_id, user_id, kind, observed_at, time_basis, source, book, odds_decimal, price, line)
    values (p.id, p.user_id, 'CLOSE', coalesce(new.closing_recorded_at, now()), 'RECORDED', coalesce(new.closing_source, 'USER'), new.closing_book,
            case when p.platform_type = 'SPORTSBOOK' then new.closing_odds_decimal end, case when p.platform_type = 'PREDICTION_MARKET' then new.closing_price end,
            new.closing_line)
    on conflict do nothing;
  end if;
  return null;
end $$;
drop trigger if exists portfolio_journal_path_trg on public.portfolio_journal_entries;
create trigger portfolio_journal_path_trg after insert or update on public.portfolio_journal_entries
  for each row execute function public.portfolio_path_from_journal();

-- THE FEED. For a position whose snapshot names an exact capture key
-- (signals.sig_key — the same event, market, side and line), the book's own
-- price history from book_quote_ticks: every tick at the book the reader used
-- between the decision and the start, and — when the journal has no close —
-- the last tick at or before the start, no more than 6 hours before it, as
-- an EDGEDESK_CAPTURE close. Nothing is matched by name or guessed; a
-- position without an exact key gets no feed points. The service role only.
create or replace function public.portfolio_svc_attach_feed_path(p_limit int default 200)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare r record; t record; n_pos int := 0; n_pts int := 0; n_close int := 0; k int;
begin
  perform public.portfolio_svc_assert();
  if to_regclass('public.book_quote_ticks') is null then return jsonb_build_object('feed', false); end if;
  for r in
    select p.id, p.user_id, p.platform, p.line, p.event_start_at, s.market->>'sig_key' as sig_key, s.recorded_at,
           coalesce(s.saved_at, s.recorded_at) as since, (s.market->>'line')::numeric as snap_line, j.closing_odds_decimal
      from public.portfolio_decision_snapshots s
      join public.portfolio_positions p on p.id = s.position_id
      join public.portfolio_journal_entries j on j.position_id = p.id
     where p.platform_type = 'SPORTSBOOK' and s.market ? 'sig_key' and p.event_start_at is not null
       and p.position_type not in ('PARLAY', 'SAME_GAME_PARLAY')
       and p.event_start_at > now() - interval '3 days'
       and p.line is not distinct from (s.market->>'line')::numeric
     order by p.event_start_at limit greatest(1, least(coalesce(p_limit, 200), 2000))
  loop
    n_pos := n_pos + 1;
    execute 'insert into public.portfolio_market_path (position_id, user_id, kind, observed_at, time_basis, source, book, odds_decimal, line)
             select $1, $2, ''QUOTE'', t.seen_at, ''OBSERVED'', ''book_quote_ticks'', t.book_key, t.dec, $3
               from public.book_quote_ticks t
              where t.sig_key = $4 and t.book_key = $5 and t.dec > 1 and t.dec <= 10001
                and t.seen_at >= $6 - interval ''1 hour'' and t.seen_at <= $7
             on conflict do nothing'
      using r.id, r.user_id, r.line, r.sig_key, r.platform, r.since, r.event_start_at;
    get diagnostics k = row_count; n_pts := n_pts + k;
    if r.closing_odds_decimal is null and r.event_start_at <= now() then
      execute 'select t.dec, t.seen_at from public.book_quote_ticks t
                where t.sig_key = $1 and t.book_key = $2 and t.dec > 1 and t.dec <= 10001 and t.seen_at <= $3
                order by t.seen_at desc limit 1' into t using r.sig_key, r.platform, r.event_start_at;
      if t.dec is not null and t.seen_at >= r.event_start_at - interval '6 hours' then
        update public.portfolio_journal_entries set closing_odds_decimal = t.dec, closing_line = r.line, closing_source = 'EDGEDESK_CAPTURE',
               closing_book = r.platform
         where position_id = r.id and closing_odds_decimal is null and closing_price is null;
        get diagnostics k = row_count;
        if k > 0 then
          n_close := n_close + 1;
          insert into public.portfolio_market_path (position_id, user_id, kind, observed_at, time_basis, source, book, odds_decimal, line)
          values (r.id, r.user_id, 'CLOSE', t.seen_at, 'OBSERVED', 'book_quote_ticks', r.platform, t.dec, r.line) on conflict do nothing;
        end if;
      end if;
    end if;
  end loop;
  return jsonb_build_object('feed', true, 'positions', n_pos, 'points', n_pts, 'closes', n_close);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. REFLECTIONS — every version of the review, append-only
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.portfolio_reflections (
  id            bigint      generated always as identity primary key,
  position_id   uuid        not null,
  user_id       uuid        not null references auth.users(id) on delete cascade,
  written_at    timestamptz not null default now(),
  would_repeat  text        null,
  review_note   text        null,
  library       text        null,
  result_known  boolean     not null,
  result        text        null,
  constraint portfolio_reflections_position_fk foreign key (position_id, user_id)
    references public.portfolio_positions (id, user_id) on delete cascade
);
comment on table public.portfolio_reflections is
  'APPEND-ONLY. Every version of the reader''s review of a position, stamped with whether the result was known when it was written. The journal''s REVIEW block is the latest; this is the history.';
create index if not exists portfolio_reflections_position on public.portfolio_reflections (user_id, position_id, written_at);

create or replace function public.portfolio_reflections_guard() returns trigger
language plpgsql as $$
begin
  raise exception 'portfolio: a reflection, once written, is never rewritten' using errcode = '42501';
end $$;
drop trigger if exists portfolio_reflections_guard_trg on public.portfolio_reflections;
create trigger portfolio_reflections_guard_trg before update on public.portfolio_reflections
  for each row execute function public.portfolio_reflections_guard();

create or replace function public.portfolio_reflection_log() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare st text; res text;
begin
  if tg_op = 'UPDATE' and (new.would_repeat, new.review_note, new.library) is not distinct from (old.would_repeat, old.review_note, old.library) then
    return null;
  end if;
  if tg_op = 'INSERT' and coalesce(new.would_repeat, new.review_note, new.library) is null then return null; end if;
  select status, result into st, res from public.portfolio_positions where id = new.position_id;
  insert into public.portfolio_reflections (position_id, user_id, written_at, would_repeat, review_note, library, result_known, result)
  values (new.position_id, new.user_id, coalesce(new.reviewed_at, now()), new.would_repeat, new.review_note, new.library,
          coalesce(st, 'OPEN') <> 'OPEN', case when coalesce(st, 'OPEN') <> 'OPEN' then res end);
  return null;
end $$;
drop trigger if exists portfolio_journal_reflection_trg on public.portfolio_journal_entries;
create trigger portfolio_journal_reflection_trg after insert or update on public.portfolio_journal_entries
  for each row execute function public.portfolio_reflection_log();
