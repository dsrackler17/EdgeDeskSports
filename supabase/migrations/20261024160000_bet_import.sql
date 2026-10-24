-- =============================================================================
-- bet_import.sql — Screenshot / Paste Import for the reader's own picks.
--
-- WHAT IT IS
--   Books with no history export (Novig, ProphetX, Kalshi, DraftKings
--   Predictions, …) get a faster way in than one bet at a time: the reader
--   uploads screenshots of their bet history, or pastes the text of it; the
--   parse_bet_import edge function reads them with Claude (vision) into one
--   structured row per bet; the reader checks and edits every row; and the
--   confirmed rows go through the Portfolio's EXISTING import pipeline —
--   portfolio_imports → portfolio_import_rows → portfolio_import_classify()
--   → portfolio_import_commit() (supabase/portfolio.sql) — into the EXISTING
--   table, public.portfolio_positions. There is no second picks table.
--
-- WHAT THIS FILE ADDS
--   1. Two provenance values for portfolio_positions.source and
--      portfolio_transactions.source: IMPORT_SCREENSHOT and IMPORT_PASTE
--      (upper case, like MANUAL / CSV / SYNC / EDGEDESK). The commit stores
--      every imported row as 'CSV'; portfolio_import_source() re-labels a row
--      at insert when the import that created it is a screenshot_v1 or
--      paste_v1 import. RLS is the same owner rule as before — the two insert
--      policies only gain the two values (portfolio.sql says the same thing,
--      so re-running either file never narrows the other).
--   2. Three columns on portfolio_positions:
--        price_display   the price exactly as the book showed it ("54¢", "+120")
--        price_american  that price as American odds, DERIVED by trigger for
--                        both instruments (a 54¢ contract is -117; 40¢ is
--                        +150), never accepted from a client
--        market_sig_key  the EdgeDesk capture key (signals.sig_key) of the
--                        exact game market the pick was matched to
--   3. portfolio_bet_import_finalize(import): after the commit, copies the
--      display price, the matched game and its start time from the reviewed
--      rows onto the positions they became (the commit's column list does not
--      carry them). Runs as the caller.
--   4. bet_import_events() / bet_import_markets(): the EdgeDesk games (from
--      public.signals) a pick can be matched to, so CLV can be graded. Event
--      identity only — teams, start, the market keys — never a price.
--   5. portfolio_svc_attach_import_close(): every fifteen minutes (pg_cron),
--      the close for matched imported singles — the reader's own book's last
--      captured tick before the start (book_quote_ticks), else EdgeDesk's own
--      close for that market (signals) — as an EDGEDESK_CAPTURE close on the
--      journal, which is what the Portfolio's CLV is computed from.
--   6. The per-reader allowance for the edge function: bet_import_policy (one
--      row), bet_import_usage (one row per parse request), and
--      bet_import_claim() / bet_import_settle(). A claim is atomic per reader
--      (advisory lock), so two isolates cannot both take the last request.
--
-- WHAT IT NEVER DOES
--   - store an uploaded image: images go browser → edge function → the model
--     and are dropped; no table here has a column that could hold one;
--   - save a pick the reader did not confirm: nothing is staged until the
--     reader presses Confirm, and the commit's own rules decide the rest
--     (duplicates by fingerprint skipped, invalid rows refused, never merged);
--   - touch another reader's rows: every reader function is security invoker
--     under the existing owner-only RLS, except the allowance (keyed to
--     auth.uid() and nothing else) and the event lookups (no reader data).
--
-- ORDER: after supabase/portfolio.sql (required), portfolio_journal.sql and
-- portfolio_decision.sql (optional: without them there is no journal to put a
-- close on, and the close job does nothing). Safe on a live site (tables are
-- taken with NOWAIT and retried, as portfolio.sql does).
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- Mirrored in supabase/migrations/20261024160000_bet_import.sql.
-- =============================================================================

do $$ begin
  if to_regclass('public.portfolio_positions') is null or to_regprocedure('public.portfolio_import_commit(uuid,integer)') is null then
    raise exception 'bet_import: run supabase/portfolio.sql first';
  end if;
end $$;

-- the tables this file alters or re-triggers, taken at once without waiting
-- while holding any (portfolio.sql's own rule: a reader's save can never
-- deadlock a migration)
do $lock$
declare tries int := 0; tables text;
begin
  select string_agg(format('%I.%I', schemaname, tablename), ', ') into tables from pg_tables
   where schemaname = 'public' and tablename in ('portfolio_positions', 'portfolio_transactions', 'portfolio_imports');
  loop
    begin
      execute 'lock table ' || tables || ' in access exclusive mode nowait';
      return;
    exception when lock_not_available then
      tries := tries + 1;
      if tries > 300 then raise exception 'bet_import: the portfolio tables stayed busy for a minute; run this file again when traffic is quieter'; end if;
      perform pg_sleep(0.2);
    end;
  end loop;
end $lock$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. PROVENANCE: IMPORT_SCREENSHOT and IMPORT_PASTE
-- ─────────────────────────────────────────────────────────────────────────────
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'portfolio_positions_source' and pg_get_constraintdef(oid) not like '%IMPORT_SCREENSHOT%') then
    alter table public.portfolio_positions drop constraint portfolio_positions_source;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'portfolio_positions_source') then
    alter table public.portfolio_positions add constraint portfolio_positions_source
      check (source in ('MANUAL', 'CSV', 'SYNC', 'EDGEDESK', 'IMPORT_SCREENSHOT', 'IMPORT_PASTE'));
  end if;
  if exists (select 1 from pg_constraint where conname = 'portfolio_transactions_source' and pg_get_constraintdef(oid) not like '%IMPORT_SCREENSHOT%') then
    alter table public.portfolio_transactions drop constraint portfolio_transactions_source;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'portfolio_transactions_source') then
    alter table public.portfolio_transactions add constraint portfolio_transactions_source
      check (source in ('MANUAL', 'CSV', 'SYNC', 'EDGEDESK', 'IMPORT_SCREENSHOT', 'IMPORT_PASTE'));
  end if;
end $$;

-- The same owner rule as portfolio.sql, with the two values added (that file
-- carries the identical text, so whichever runs last leaves the same policy).
drop policy if exists portfolio_positions_insert_own on public.portfolio_positions;
create policy portfolio_positions_insert_own on public.portfolio_positions for insert to authenticated
  with check (user_id = auth.uid() and source in ('MANUAL', 'CSV', 'EDGEDESK', 'IMPORT_SCREENSHOT', 'IMPORT_PASTE'));
drop policy if exists portfolio_transactions_insert_own on public.portfolio_transactions;
create policy portfolio_transactions_insert_own on public.portfolio_transactions for insert to authenticated
  with check (user_id = auth.uid() and source in ('MANUAL', 'CSV', 'EDGEDESK', 'IMPORT_SCREENSHOT', 'IMPORT_PASTE'));

-- which importer means which provenance
create or replace function public.portfolio_import_source_for(p_importer text)
returns text language sql immutable as $$
  select case p_importer when 'screenshot_v1' then 'IMPORT_SCREENSHOT' when 'paste_v1' then 'IMPORT_PASTE' end
$$;

-- A row the import commit writes says 'CSV'; when its import is a screenshot
-- or paste import it is labelled so at insert, before the row is checked
-- against RLS. Fires after portfolio_positions_derive_trg /
-- portfolio_transactions_prepare_trg (trigger names sort that way), so the
-- account the position is filed under is the same one a CSV import opens.
create or replace function public.portfolio_import_source() returns trigger
language plpgsql as $$
declare v text;
begin
  if new.source = 'CSV' and new.import_id is not null then
    select public.portfolio_import_source_for(i.importer) into v from public.portfolio_imports i
     where i.id = new.import_id and i.user_id = new.user_id;
    if v is not null then new.source := v; end if;
  end if;
  return new;
end $$;
drop trigger if exists portfolio_positions_source_trg on public.portfolio_positions;
create trigger portfolio_positions_source_trg before insert on public.portfolio_positions
  for each row execute function public.portfolio_import_source();
drop trigger if exists portfolio_transactions_source_trg on public.portfolio_transactions;
create trigger portfolio_transactions_source_trg before insert on public.portfolio_transactions
  for each row execute function public.portfolio_import_source();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. THE PRICE AS SHOWN, THE PRICE AS AMERICAN ODDS, AND THE MATCHED MARKET
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.portfolio_positions add column if not exists price_display text null;
alter table public.portfolio_positions add column if not exists price_american integer null;
alter table public.portfolio_positions add column if not exists market_sig_key text null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'portfolio_positions_import_meta') then
    alter table public.portfolio_positions add constraint portfolio_positions_import_meta
      check (coalesce(length(price_display), 0) <= 40 and coalesce(length(market_sig_key), 0) <= 300
        and (price_american is null or ((price_american <= -100 or price_american >= 100) and abs(price_american) <= 1000000)));
  end if;
end $$;
comment on column public.portfolio_positions.price_display is
  'The price exactly as the platform displayed it ("54¢", "+120", "1.91"), as the reader confirmed it on import. Display only; the money is computed from odds_american / odds_decimal or the fills.';
comment on column public.portfolio_positions.price_american is
  'DERIVED. The entry price as American odds for either instrument: a wager''s own odds, or a contract''s average entry price read as a probability (54¢ → -117, 40¢ → +150). Never accepted from a client.';
comment on column public.portfolio_positions.market_sig_key is
  'The EdgeDesk capture key (signals.sig_key: event|market|selection|point) of the game market this position was matched to on import. The close for CLV is read from it.';
create index if not exists portfolio_positions_sig_key on public.portfolio_positions (market_sig_key) where market_sig_key is not null;

-- a probability (a contract's price in dollars) as American odds, rounded half
-- away from zero by portfolio_div_round: 0.54 → -117, 0.40 → +150, 0.50 → +100.
-- lib/edgedesk_bet_import.js probToAmerican() is the same rule.
create or replace function public.portfolio_prob_to_american(p numeric)
returns integer language sql immutable as $$
  select case when p is null or p <= 0 or p >= 1 then null
              when p > 0.5 then -public.portfolio_div_round(100 * p, 1 - p, 0)::int
              else public.portfolio_div_round(100 * (1 - p), p, 0)::int end
$$;
create or replace function public.portfolio_decimal_to_american(d numeric)
returns integer language sql immutable as $$
  select case when d is null or d <= 1 then null
              when d >= 2 then public.portfolio_div_round((d - 1) * 100, 1, 0)::int
              else -public.portfolio_div_round(100, d - 1, 0)::int end
$$;

create or replace function public.portfolio_positions_price_american() returns trigger
language plpgsql as $$
begin
  new.price_american := case when new.platform_type = 'SPORTSBOOK'
    then coalesce(new.odds_american, public.portfolio_decimal_to_american(new.odds_decimal))
    else public.portfolio_prob_to_american(new.average_entry_price) end;
  new.price_display := nullif(btrim(new.price_display), '');
  new.market_sig_key := nullif(btrim(new.market_sig_key), '');
  return new;
end $$;
-- after portfolio_positions_derive_trg (which fills average_entry_price from
-- the fills). Positions that existed before this file get the column the next
-- time they are written: back-filling here would re-run every position's
-- triggers and restamp its updated_at, which the journal's facts cache reads.
drop trigger if exists portfolio_positions_price_trg on public.portfolio_positions;
create trigger portfolio_positions_price_trg before insert or update on public.portfolio_positions
  for each row execute function public.portfolio_positions_price_american();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. AFTER THE COMMIT: the reviewed details onto the positions they became
-- ─────────────────────────────────────────────────────────────────────────────
-- The commit's column list carries the event id (and a wager's start time)
-- but not the price as displayed or the matched market; the staged row's raw
-- object holds them, as the reader confirmed them. Only positions this import
-- created (a fill that joined an existing position leaves that one alone),
-- only empty fields, so running it twice changes nothing. Security invoker:
-- RLS decides.
create or replace function public.portfolio_bet_import_finalize(p_import uuid)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare imp public.portfolio_imports; n int;
begin
  select * into imp from public.portfolio_imports where id = p_import;
  if not found then raise exception 'bet_import: no such import' using errcode = 'P0002'; end if;
  if public.portfolio_import_source_for(imp.importer) is null then
    raise exception 'bet_import: not a screenshot or paste import' using errcode = '22023';
  end if;
  if imp.status <> 'COMMITTED' then raise exception 'bet_import: commit the import first' using errcode = '55000'; end if;
  update public.portfolio_positions p
     set price_display = coalesce(p.price_display, left(nullif(btrim(x.raw->>'price_display'), ''), 40)),
         market_sig_key = coalesce(p.market_sig_key, left(nullif(btrim(x.raw->>'market_sig_key'), ''), 300)),
         event_id = coalesce(p.event_id, left(nullif(btrim(x.raw->>'event_id'), ''), 120)),
         event_start_at = coalesce(p.event_start_at, public.portfolio_try_timestamptz(x.raw->>'event_start_at'))
    from (select distinct on (r.position_id) r.position_id, r.raw
            from public.portfolio_import_rows r
           where r.import_id = p_import and r.position_id is not null and r.outcome = 'IMPORTED'
           order by r.position_id, r.row_number) x
   where p.id = x.position_id and p.import_id = p_import and p.source <> 'SYNC'
     and ((p.price_display is null and nullif(btrim(x.raw->>'price_display'), '') is not null)
       or (p.market_sig_key is null and nullif(btrim(x.raw->>'market_sig_key'), '') is not null)
       or (p.event_id is null and nullif(btrim(x.raw->>'event_id'), '') is not null)
       or (p.event_start_at is null and public.portfolio_try_timestamptz(x.raw->>'event_start_at') is not null));
  get diagnostics n = row_count;
  return jsonb_build_object('import_id', p_import, 'positions_updated', n);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. THE GAMES A PICK CAN BE MATCHED TO (public.signals, EdgeDesk's capture)
-- ─────────────────────────────────────────────────────────────────────────────
-- Identity only: the event id, the league, the two teams and the start. No
-- price, edge or grade leaves through these, so they read signals as their
-- owner (signals' own grants are not this file's to change). A window is at
-- most 45 days and returns at most 3,000 events. Without signals installed
-- they return nothing, and the page says matching is unavailable.
create or replace function public.bet_import_events(p_from timestamptz, p_to timestamptz, p_sports text[] default null)
returns table (event_id text, sport_key text, sport_title text, commence_time timestamptz, home_team text, away_team text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'bet_import: sign in first' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > interval '45 days' then
    raise exception 'bet_import: a window of at most 45 days' using errcode = '22023';
  end if;
  if to_regclass('public.signals') is null then return; end if;
  return query execute
    'select q.event_id::text, q.sport_key::text, q.sport_title::text, q.commence_time::timestamptz, q.home_team::text, q.away_team::text
       from (select distinct on (s.event_id) s.event_id, s.sport_key, s.sport_title, s.commence_time, s.home_team, s.away_team
               from public.signals s
              where s.commence_time >= $1 and s.commence_time <= $2
                and ($3 is null or s.sport_key = any ($3))
                and s.market in (''h2h'', ''spreads'', ''totals'')
                and s.event_id is not null and s.home_team is not null and s.away_team is not null
              order by s.event_id, s.commence_time desc) q
      order by q.commence_time, q.event_id
      limit 3000'
    using p_from, p_to, p_sports;
end $$;

-- the game markets of up to 50 matched events: what a pick's sig_key can be
create or replace function public.bet_import_markets(p_event_ids text[])
returns table (event_id text, market text, selection text, point numeric, sig_key text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'bet_import: sign in first' using errcode = '42501'; end if;
  if p_event_ids is null or cardinality(p_event_ids) = 0 then return; end if;
  if cardinality(p_event_ids) > 50 then raise exception 'bet_import: at most 50 events at a time' using errcode = '22023'; end if;
  if to_regclass('public.signals') is null then return; end if;
  return query execute
    'select s.event_id::text, s.market::text, s.selection::text, s.point::numeric, s.sig_key::text
       from public.signals s
      where s.event_id = any ($1) and s.market in (''h2h'', ''spreads'', ''totals'') and s.sig_key is not null
      order by s.event_id, s.market, s.selection, s.point
      limit 5000'
    using p_event_ids;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. THE CLOSE FOR MATCHED IMPORTED SINGLES (the service role's)
-- ─────────────────────────────────────────────────────────────────────────────
-- For an imported moneyline / spread / total at a sportsbook, matched to a
-- capture key whose point is the pick's own line, once the game has started:
--   1. the reader's own book's last captured tick at or before the start, no
--      more than 6 hours before it (book_quote_ticks — the Decision Record
--      feed's rule, portfolio_svc_attach_feed_path);
--   2. else EdgeDesk's own recorded close for that market (signals.closing_dec)
--      when it was taken at or before the start.
-- Written once to the journal as an EDGEDESK_CAPTURE close (the journal's
-- close fields are write-once), with a CLOSE point on the market path. A pick
-- whose game is more than 14 days gone, or that has a close already, is left
-- alone. Nothing is matched by name here: only the stored key is used.
create or replace function public.portfolio_svc_attach_import_close(p_limit int default 300)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare r record; t record; n_pos int := 0; n_close int := 0; k int; have_ticks boolean; have_signals boolean; have_path boolean;
begin
  if current_user not in ('service_role', 'postgres', 'supabase_admin') then
    raise exception 'bet_import: this is the scheduler''s function, not a reader''s' using errcode = '42501';
  end if;
  if to_regclass('public.portfolio_journal_entries') is null then return jsonb_build_object('journal', false); end if;
  have_ticks := to_regclass('public.book_quote_ticks') is not null;
  have_signals := to_regclass('public.signals') is not null
    and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'signals' and column_name = 'closing_dec')
    and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'signals' and column_name = 'closed_at');
  have_path := to_regclass('public.portfolio_market_path') is not null;
  for r in
    select p.id, p.user_id, p.platform, p.line, p.event_start_at, p.market_sig_key
      from public.portfolio_positions p
      join public.portfolio_journal_entries j on j.position_id = p.id
     where p.source in ('IMPORT_SCREENSHOT', 'IMPORT_PASTE') and p.platform_type = 'SPORTSBOOK'
       and p.position_type in ('MONEYLINE', 'SPREAD', 'TOTAL') and jsonb_array_length(coalesce(p.legs, '[]'::jsonb)) <= 1
       and p.market_sig_key is not null and p.event_start_at is not null
       and p.event_start_at <= now() and p.event_start_at > now() - interval '14 days'
       and p.line is not distinct from public.portfolio_try_numeric(nullif(split_part(p.market_sig_key, '|', 4), ''))
       and j.closing_odds_decimal is null and j.closing_price is null
     order by p.event_start_at desc
     limit greatest(1, least(coalesce(p_limit, 300), 2000))
  loop
    n_pos := n_pos + 1;
    t := null;
    if have_ticks then
      execute 'select t.dec, t.seen_at, $2::text as book from public.book_quote_ticks t
                where t.sig_key = $1 and t.book_key = $2 and t.dec > 1 and t.dec <= 10001 and t.seen_at <= $3
                  and t.seen_at >= $3 - interval ''6 hours''
                order by t.seen_at desc limit 1' into t using r.market_sig_key, r.platform, r.event_start_at;
    end if;
    if (t is null or t.dec is null) and have_signals then
      begin
        execute 'select s.closing_dec::numeric as dec, s.closed_at::timestamptz as seen_at, ''edgedesk_close''::text as book from public.signals s
                  where s.sig_key = $1 and s.closing_dec > 1 and s.closing_dec <= 10001 and s.closed_at <= $2 + interval ''5 minutes''
                  limit 1' into t using r.market_sig_key, r.event_start_at;
      exception when others then t := null;  /* a signals layout this file does not know: no close, never an error */
      end;
    end if;
    if t is null or t.dec is null then continue; end if;
    update public.portfolio_journal_entries set closing_odds_decimal = t.dec, closing_line = r.line, closing_source = 'EDGEDESK_CAPTURE',
           closing_book = left(t.book, 60)
     where position_id = r.id and closing_odds_decimal is null and closing_price is null;
    get diagnostics k = row_count;
    if k > 0 then
      n_close := n_close + 1;
      if have_path then
        insert into public.portfolio_market_path (position_id, user_id, kind, observed_at, time_basis, source, book, odds_decimal, line)
        values (r.id, r.user_id, 'CLOSE', t.seen_at, 'OBSERVED', case when t.book = 'edgedesk_close' then 'EDGEDESK_CAPTURE' else 'book_quote_ticks' end,
                left(t.book, 60), t.dec, r.line)
        on conflict do nothing;
      end if;
    end if;
  end loop;
  return jsonb_build_object('journal', true, 'positions', n_pos, 'closes', n_close);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. THE ALLOWANCE: how many parse requests a reader may make
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.bet_import_policy (
  id                 int primary key default 1 check (id = 1),
  enabled            boolean not null default true,
  per_hour           int not null default 20 check (per_hour >= 0),
  per_day            int not null default 60 check (per_day >= 0),
  images_per_day     int not null default 200 check (images_per_day >= 0),
  global_per_day     int not null default 3000 check (global_per_day >= 0),
  updated_at         timestamptz not null default now(),
  note               text
);
insert into public.bet_import_policy (id) values (1) on conflict (id) do nothing;
comment on table public.bet_import_policy is
  'One row. How many parse_bet_import requests a reader may make per hour and per day, how many images per day, and a ceiling across all readers per day. Edit with the service role; enabled = false stops every request.';

create table if not exists public.bet_import_usage (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  kind         text not null,
  status       text not null,
  reason       text null,
  images       int not null default 0,
  bytes        bigint not null default 0,
  chars        int not null default 0,
  settled_at   timestamptz null,
  outcome      text null,
  model        text null,
  tokens_in    int null,
  tokens_out   int null,
  bets         int null,
  flagged      int null,
  ms           int null,
  constraint bet_import_usage_kind check (kind in ('screenshot', 'paste')),
  constraint bet_import_usage_status check (status in ('CLAIMED', 'REFUSED')),
  constraint bet_import_usage_outcome check (outcome is null or outcome in ('parsed', 'no_bets', 'refused', 'invalid_output', 'upstream_error', 'timed_out', 'error')),
  constraint bet_import_usage_numbers check (images between 0 and 50 and bytes >= 0 and chars >= 0
    and coalesce(tokens_in, 0) >= 0 and coalesce(tokens_out, 0) >= 0 and coalesce(bets, 0) >= 0 and coalesce(flagged, 0) >= 0 and coalesce(ms, 0) >= 0
    and coalesce(length(reason), 0) <= 40 and coalesce(length(model), 0) <= 80)
);
create index if not exists bet_import_usage_user_time on public.bet_import_usage (user_id, created_at desc);
create index if not exists bet_import_usage_time on public.bet_import_usage (created_at);
comment on table public.bet_import_usage is
  'One row per parse_bet_import request: what was sent (counts and sizes only — never an image or its text), whether the allowance admitted it, and what the model returned (counts and tokens). Written only by bet_import_claim() and bet_import_settle().';

alter table public.bet_import_policy enable row level security;
alter table public.bet_import_usage enable row level security;
drop policy if exists bet_import_usage_select_own on public.bet_import_usage;
create policy bet_import_usage_select_own on public.bet_import_usage for select to authenticated using (user_id = auth.uid());
revoke all on public.bet_import_policy, public.bet_import_usage from anon, authenticated;
grant select on public.bet_import_usage to authenticated;
grant select, insert, update on public.bet_import_policy, public.bet_import_usage to service_role;

-- One claim per parse request, for the caller only, decided under a lock on
-- the caller so two isolates cannot both take the last request. Refused
-- claims are recorded too (that is how abuse shows), and never count.
create or replace function public.bet_import_claim(p_kind text, p_images int, p_bytes bigint, p_chars int)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); pol public.bet_import_policy; h int; d int; img int; g int; why text; retry int; v_id bigint;
begin
  if me is null then raise exception 'bet_import: sign in first' using errcode = '42501'; end if;
  if p_kind not in ('screenshot', 'paste') then raise exception 'bet_import: kind is screenshot or paste' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('bet_import:' || me::text, 0));
  select * into pol from public.bet_import_policy where id = 1;
  select count(*) filter (where created_at > now() - interval '1 hour'), count(*), coalesce(sum(images), 0)
    into h, d, img from public.bet_import_usage
   where user_id = me and status = 'CLAIMED' and created_at > now() - interval '24 hours';
  select count(*) into g from public.bet_import_usage where status = 'CLAIMED' and created_at > now() - interval '24 hours';
  why := case when pol.id is null or not pol.enabled then 'DISABLED'
              when h >= pol.per_hour then 'HOURLY_LIMIT'
              when d >= pol.per_day then 'DAILY_LIMIT'
              when img + greatest(coalesce(p_images, 0), 0) > pol.images_per_day then 'IMAGE_LIMIT'
              when g >= pol.global_per_day then 'SERVICE_BUSY' end;
  retry := case why when 'HOURLY_LIMIT' then
                  greatest(60, ceil(extract(epoch from ((select min(created_at) from public.bet_import_usage
                    where user_id = me and status = 'CLAIMED' and created_at > now() - interval '1 hour') + interval '1 hour' - now())))::int)
                when 'DAILY_LIMIT' then 3600 when 'IMAGE_LIMIT' then 3600 when 'SERVICE_BUSY' then 3600 end;
  insert into public.bet_import_usage (user_id, kind, status, reason, images, bytes, chars)
  values (me, p_kind, case when why is null then 'CLAIMED' else 'REFUSED' end, why,
          least(greatest(coalesce(p_images, 0), 0), 50), greatest(coalesce(p_bytes, 0), 0), greatest(coalesce(p_chars, 0), 0))
  returning id into v_id;
  return jsonb_build_object('ok', why is null, 'id', v_id, 'reason', why, 'retry_after_s', retry,
    'used_hour', h + case when why is null then 1 else 0 end, 'per_hour', pol.per_hour,
    'used_day', d + case when why is null then 1 else 0 end, 'per_day', pol.per_day);
end $$;

-- the outcome of a claimed request, once
create or replace function public.bet_import_settle(p_id bigint, p_outcome text, p_model text, p_tokens_in int, p_tokens_out int,
    p_bets int, p_flagged int, p_ms int)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if auth.uid() is null then raise exception 'bet_import: sign in first' using errcode = '42501'; end if;
  update public.bet_import_usage set settled_at = now(), outcome = p_outcome, model = left(p_model, 80),
         tokens_in = greatest(p_tokens_in, 0), tokens_out = greatest(p_tokens_out, 0), bets = greatest(p_bets, 0),
         flagged = greatest(p_flagged, 0), ms = greatest(p_ms, 0)
   where id = p_id and user_id = auth.uid() and status = 'CLAIMED' and settled_at is null;
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. GRANTS
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace s on s.oid = p.pronamespace
            where s.nspname = 'public' and p.proname in ('portfolio_import_source_for', 'portfolio_import_source', 'portfolio_prob_to_american',
              'portfolio_decimal_to_american', 'portfolio_positions_price_american', 'portfolio_bet_import_finalize', 'bet_import_events',
              'bet_import_markets', 'bet_import_claim', 'bet_import_settle', 'portfolio_svc_attach_import_close') loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('revoke all on function %s from anon', f.sig);
    if f.proname = 'portfolio_svc_attach_import_close' then
      execute format('revoke all on function %s from authenticated', f.sig);
      execute format('grant execute on function %s to service_role', f.sig);
    else
      execute format('grant execute on function %s to authenticated, service_role', f.sig);
    end if;
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. THE SCHEDULE: the close job every fifteen minutes, where pg_cron exists
-- ─────────────────────────────────────────────────────────────────────────────
do $$ begin
  if to_regclass('cron.job') is not null then
    perform cron.unschedule(jobid) from cron.job where jobname = 'portfolio_import_close';
    perform cron.schedule('portfolio_import_close', '7,22,37,52 * * * *', 'select public.portfolio_svc_attach_import_close(500);');
  end if;
end $$;
-- for the report: null where there is no pg_cron (read dynamically, so this
-- file also applies where the cron schema does not exist)
create or replace function public.bet_import_close_scheduled() returns boolean
language plpgsql stable set search_path = public, pg_temp as $$
declare ok boolean;
begin
  if to_regclass('cron.job') is null then return null; end if;
  execute 'select exists (select 1 from cron.job where jobname = ''portfolio_import_close'' and active)' into ok;
  return ok;
end $$;
revoke all on function public.bet_import_close_scheduled() from public, anon, authenticated;

notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- THE REPORT. Every row should read ok.
-- ─────────────────────────────────────────────────────────────────────────────
select step, item, outcome from (
  select 1 as step, 'positions and fills accept IMPORT_SCREENSHOT and IMPORT_PASTE' as item,
    case when (select count(*) from pg_constraint where conname in ('portfolio_positions_source', 'portfolio_transactions_source')
      and pg_get_constraintdef(oid) like '%IMPORT_SCREENSHOT%' and pg_get_constraintdef(oid) like '%IMPORT_PASTE%') = 2
      then 'ok' else 'CHECK THIS — a source constraint is narrow' end as outcome
  union all select 2, 'the insert policies are still owner-only, with the two values',
    case when (select count(*) from pg_policies where schemaname = 'public' and policyname in ('portfolio_positions_insert_own', 'portfolio_transactions_insert_own')
      and with_check like '%user_id = auth.uid()%' and with_check like '%IMPORT_SCREENSHOT%' and with_check like '%IMPORT_PASTE%' and with_check not like '%SYNC%') = 2
      then 'ok' else 'CHECK THIS — re-run this file after supabase/portfolio.sql' end
  union all select 3, 'an imported row is labelled by its import, at insert',
    case when (select count(*) from pg_trigger where tgname in ('portfolio_positions_source_trg', 'portfolio_transactions_source_trg') and not tgisinternal) = 2
      and public.portfolio_import_source_for('screenshot_v1') = 'IMPORT_SCREENSHOT' and public.portfolio_import_source_for('paste_v1') = 'IMPORT_PASTE'
      and public.portfolio_import_source_for('generic_sportsbook_v1') is null then 'ok' else 'CHECK THIS' end
  union all select 4, 'cents read as American odds: 54¢ = -117, 40¢ = +150, 50¢ = +100; decimal 1.91 = -110',
    case when public.portfolio_prob_to_american(0.54) = -117 and public.portfolio_prob_to_american(0.40) = 150
      and public.portfolio_prob_to_american(0.50) = 100 and public.portfolio_prob_to_american(1) is null
      and public.portfolio_decimal_to_american(1.91) = -110 and public.portfolio_decimal_to_american(2.5) = 150 then 'ok' else 'CHECK THIS' end
  union all select 5, 'price_american is derived by trigger, after the P&L trigger',
    case when exists (select 1 from pg_trigger where tgname = 'portfolio_positions_price_trg' and not tgisinternal)
      and 'portfolio_positions_derive_trg' < 'portfolio_positions_price_trg' then 'ok' else 'CHECK THIS' end
  union all select 6, 'the allowance: RLS on, readers read only their own usage and cannot write it',
    case when (select count(*) from pg_tables where schemaname = 'public' and tablename in ('bet_import_policy', 'bet_import_usage') and rowsecurity) = 2
      and has_table_privilege('authenticated', 'public.bet_import_usage', 'select')
      and not has_table_privilege('authenticated', 'public.bet_import_usage', 'insert')
      and not has_table_privilege('authenticated', 'public.bet_import_usage', 'update')
      and not has_table_privilege('authenticated', 'public.bet_import_policy', 'select')
      and exists (select 1 from public.bet_import_policy where id = 1) then 'ok' else 'CHECK THIS' end
  union all select 7, 'anon can call none of it; the close job is the service role''s alone',
    case when not has_function_privilege('anon', 'public.bet_import_claim(text,integer,bigint,integer)', 'execute')
      and not has_function_privilege('anon', 'public.bet_import_events(timestamp with time zone,timestamp with time zone,text[])', 'execute')
      and not has_function_privilege('anon', 'public.portfolio_bet_import_finalize(uuid)', 'execute')
      and not has_function_privilege('authenticated', 'public.portfolio_svc_attach_import_close(integer)', 'execute')
      and has_function_privilege('authenticated', 'public.portfolio_bet_import_finalize(uuid)', 'execute') then 'ok' else 'CHECK THIS' end
  union all select 8, 'the games to match against (public.signals)',
    case when to_regclass('public.signals') is not null then 'ok'
      else 'ok — public.signals is not installed here, so picks import unmatched' end
  union all select 9, 'the close job runs every fifteen minutes (where pg_cron is installed)',
    case when public.bet_import_close_scheduled() is null then 'ok — no pg_cron here; run select public.portfolio_svc_attach_import_close(500) yourself'
      when public.bet_import_close_scheduled() then 'ok' else 'CHECK THIS — the job is missing' end
  union all select 10, 'no column anywhere in this file can hold an image',
    case when not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name in ('bet_import_usage', 'bet_import_policy')
      and data_type in ('bytea', 'jsonb', 'json')) then 'ok' else 'CHECK THIS' end
) r order by 1;
