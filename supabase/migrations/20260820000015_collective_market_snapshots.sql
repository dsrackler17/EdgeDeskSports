-- Model Collective, migration 15: immutable market snapshots.
--
-- The Collective grades a pick against the market it actually faced, so the
-- market history has to be a record, not a current-value cache. Snapshots are
-- append-only: a later capture never edits an earlier one, and the closing
-- line is recorded once and never revised.
--
-- This migration is provider agnostic on purpose. It defines the store, the
-- write path, the attachment rule, and the closing-line rule. Any collector
-- (a scraper, a paid odds API, an existing lines feed) writes through the one
-- RPC below, so swapping providers never touches grading.

create table if not exists collective.market_snapshots (
  id           uuid primary key default gen_random_uuid(),
  game_id      uuid not null references collective.games(id),
  sport_code   text not null,
  market       text not null default 'spread',
  book         text not null,
  home_line    numeric,
  home_price   int,
  away_line    numeric,
  away_price   int,
  total_line   numeric,
  over_price   int,
  under_price  int,
  captured_at  timestamptz not null,
  source       text not null,
  created_at   timestamptz not null default now(),
  -- Home convention everywhere, same as projections: negative means the home
  -- team is favored. A collector that reads a book's away-side number must
  -- flip it before writing, never after.
  check (home_line is null or away_line is null or home_line = -away_line)
);

-- One row per book per market per instant. A collector that runs twice, or
-- retries after a timeout, cannot create a second copy of the same capture.
create unique index if not exists market_snapshots_once
  on collective.market_snapshots (game_id, market, book, source, captured_at);
create index if not exists market_snapshots_lookup
  on collective.market_snapshots (game_id, market, book, captured_at desc);

alter table collective.market_snapshots enable row level security;
grant select, insert on collective.market_snapshots to service_role;
revoke update, delete on collective.market_snapshots from service_role;
do $$ begin
  create trigger market_snapshots_append_only
    before update or delete on collective.market_snapshots
    for each row execute function collective.block_mutation();
exception when duplicate_object then null; end $$;

-- The closing line is a separate, write-once record. Grading reads a single
-- number per game; this says exactly which snapshot it came from, so any
-- graded pick can be traced back to the market that produced it.
create table if not exists collective.closing_lines (
  game_id     uuid primary key references collective.games(id),
  market      text not null default 'spread',
  snapshot_id uuid references collective.market_snapshots(id),
  book        text not null,
  home_line   numeric,
  home_price  int,
  away_price  int,
  captured_at timestamptz,
  set_at      timestamptz not null default now()
);
alter table collective.closing_lines enable row level security;
grant select, insert on collective.closing_lines to service_role;
revoke update, delete on collective.closing_lines from service_role;
do $$ begin
  create trigger closing_lines_append_only
    before update or delete on collective.closing_lines
    for each row execute function collective.block_mutation();
exception when duplicate_object then null; end $$;

-- Which book is allowed to define the closing line, and how old a snapshot
-- may be before the wall stops showing it as current.
insert into collective.config (key, value, description) values
  ('market.canonical_book', '"Pinnacle"',
   'The only book whose snapshot may become the closing line. Never substituted silently.'),
  ('market.stale_minutes', '180',
   'A snapshot older than this is not shown as the current market.')
on conflict (key) do nothing;

-- The projection records which market it was posted into. Set once at ingest,
-- never revised, so a pick keeps the number its author actually saw.
alter table collective.projections
  add column if not exists market_snapshot_id uuid references collective.market_snapshots(id);

-- ---------------------------------------------------------------- write path

-- Collectors call this. Rows are resolved to canonical games exactly the way
-- projections are, so a snapshot can never attach to a game the Collective
-- does not already know about, and no collector can invent a game.
create or replace function collective.record_market_snapshots(p_admin uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = collective as $$
declare
  r jsonb;
  v_game uuid;
  v_cap timestamptz;
  n_ok int := 0; n_dup int := 0; n_unmatched int := 0; n_bad int := 0;
  v_unmatched jsonb := '[]'::jsonb;
begin
  if not collective.is_admin(p_admin) then
    return jsonb_build_object('ok', false, 'code', 'forbidden', 'message', 'Not an admin account');
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'invalid_payload', 'message', 'rows must be an array');
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    begin
      v_cap := coalesce(nullif(r->>'captured_at','')::timestamptz, now());
      v_game := collective.resolve_game_ref(
        r->>'sport',
        nullif(r->>'season','')::int,
        r->>'home_team',
        r->>'away_team',
        nullif(r->>'kickoff','')::timestamptz);
      if v_game is null then
        n_unmatched := n_unmatched + 1;
        v_unmatched := v_unmatched || jsonb_build_object(
          'home_team', r->>'home_team', 'away_team', r->>'away_team', 'kickoff', r->>'kickoff');
        continue;
      end if;
      if coalesce(r->>'book','') = '' then n_bad := n_bad + 1; continue; end if;

      insert into collective.market_snapshots (
        game_id, sport_code, market, book,
        home_line, home_price, away_line, away_price,
        total_line, over_price, under_price, captured_at, source)
      values (
        v_game, r->>'sport', coalesce(nullif(r->>'market',''), 'spread'), r->>'book',
        nullif(r->>'home_line','')::numeric, nullif(r->>'home_price','')::int,
        nullif(r->>'away_line','')::numeric, nullif(r->>'away_price','')::int,
        nullif(r->>'total_line','')::numeric, nullif(r->>'over_price','')::int,
        nullif(r->>'under_price','')::int, v_cap,
        coalesce(nullif(r->>'source',''), 'unknown'));
      n_ok := n_ok + 1;
    exception
      when unique_violation then n_dup := n_dup + 1;
      when others then n_bad := n_bad + 1;
    end;
  end loop;

  return jsonb_build_object('ok', true, 'stored', n_ok, 'duplicates', n_dup,
    'unmatched', n_unmatched, 'rejected', n_bad, 'unmatched_rows', v_unmatched);
end $$;

-- The market a submission faced: the most recent canonical-book snapshot at
-- or before the moment the server received it. Never the newest snapshot,
-- never a different book: a pick is judged against what its author could
-- actually have seen.
create or replace function collective.market_at(p_game_id uuid, p_at timestamptz)
returns uuid language sql stable security definer set search_path = collective as $$
  select ms.id from collective.market_snapshots ms
  where ms.game_id = p_game_id
    and ms.market = 'spread'
    and ms.book = coalesce(collective.get_config('market.canonical_book') #>> '{}', 'Pinnacle')
    and ms.captured_at <= p_at
  order by ms.captured_at desc
  limit 1
$$;

-- Closing line: the last canonical-book snapshot strictly before kickoff.
-- If that book never appeared for this game the closing line is reported
-- unavailable. It is never filled in from another book, because a record
-- graded against a silently substituted market is not the record we publish.
create or replace function collective.mark_closing_line(p_admin uuid, p_game_id uuid)
returns jsonb language plpgsql security definer set search_path = collective as $$
declare
  v_book text := coalesce(collective.get_config('market.canonical_book') #>> '{}', 'Pinnacle');
  v_kick timestamptz;
  s record;
begin
  if not collective.is_admin(p_admin) then
    return jsonb_build_object('ok', false, 'code', 'forbidden', 'message', 'Not an admin account');
  end if;
  if exists (select 1 from collective.closing_lines where game_id = p_game_id) then
    return jsonb_build_object('ok', true, 'already_set', true);
  end if;
  select kickoff_at into v_kick from collective.games where id = p_game_id;
  if v_kick is null then
    return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'No such game');
  end if;

  select * into s from collective.market_snapshots
   where game_id = p_game_id and market = 'spread' and book = v_book and captured_at < v_kick
   order by captured_at desc limit 1;
  if not found then
    return jsonb_build_object('ok', true, 'closing_line', null, 'canonical_book', v_book,
      'reason', 'no canonical book snapshot before kickoff, closing line unavailable');
  end if;

  insert into collective.closing_lines (game_id, market, snapshot_id, book, home_line, home_price, away_price, captured_at)
  values (p_game_id, 'spread', s.id, s.book, s.home_line, s.home_price, s.away_price, s.captured_at);

  -- Feed grading only where no closing spread was recorded by hand. An
  -- existing number is never overwritten: settled history does not move.
  update collective.results
     set closing_spread = s.home_line
   where game_id = p_game_id and closing_spread is null;

  return jsonb_build_object('ok', true, 'closing_line', s.home_line, 'book', s.book,
    'captured_at', s.captured_at, 'snapshot_id', s.id);
end $$;

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'collective'
      and p.proname in ('record_market_snapshots','market_at','mark_closing_line')
  loop
    execute format('revoke execute on function %s from public', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
