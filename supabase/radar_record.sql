-- =============================================================================
-- radar_record.sql — the Radar record: how following Smart Money Tonight has
-- actually done. EXPERIMENTAL. docs/prediction-radar.md §The Radar record
--
-- HOW RADAR ANSWERS "CAN THIS MAKE ME MONEY": with its own unedited results,
-- never a claim. Every Smart Money Tonight card is snapshotted the first time
-- it is published, with its side and the Polymarket price at that moment (the
-- price a follower could have taken), into an APPEND-ONLY table. After the
-- game each is graded once, automatically, the way the public record grades a
-- signal: against the close (the last recorded price at or before the start,
-- at most close_max_gap_min before it) and against the result (the market's
-- own resolution). Nothing is ever edited: a correction would be a new row,
-- and there is no path to write one.
--
--   radar_cards          one row per game and side, the first time its card
--                        was published (the same function that draws Smart
--                        Money Tonight: radar_tonight_cards). APPEND-ONLY.
--   radar_card_results   one row per card, once: the close, beat-close, the
--                        settlement, the result and the ROI of one unit at the
--                        published price. APPEND-ONLY.
--
-- WHO WRITES. polymarket_sync's every-10-minute run calls radar_publish_cards()
-- and radar_grade_cards() (service role), after it has stored the holders,
-- the prices and the resolutions they read.
--
-- WHO READS. Subscribers (has_active_sub(), the terminal's rule), through
-- radar_record(): the record, ROI and beat-close rate, the cards, and what
-- H-RADAR-01 found. Labelled EXPERIMENTAL until H-RADAR-01 has passed its
-- registered criteria; a small sample until 200 cards are graded.
--
-- REQUIRES supabase/radar.sql. CONVENTION (supabase/README.md): idempotent,
-- additive, pasted into the SQL editor, no psql meta-commands, ends in a
-- report. Mirrored byte for byte in supabase/migrations/20261029130000_radar_record.sql.
-- =============================================================================

do $req$ begin
  if to_regprocedure('public.radar_tonight_cards()') is null or to_regclass('public.poly_price_snapshots') is null then
    raise exception 'radar_record.sql needs supabase/radar.sql: apply it first';
  end if;
end $req$;

begin;

-- ---------------------------------------------------------------- the cards, as published (append-only)
create table if not exists public.radar_cards (
  card_id          bigint generated always as identity primary key,
  published_at     timestamptz not null default now(),
  event_id         text not null,
  sport_key        text,
  condition_id     text not null references public.poly_markets (condition_id),
  token_id         text not null,
  market_type      text not null,
  selection        text,
  outcome          text,
  point            numeric,
  home_team        text,
  away_team        text,
  commence_time    timestamptz not null,
  n_wallets        integer not null check (n_wallets >= 1),
  dollars          numeric,
  avg_entry        numeric,
  follow_price     numeric not null check (follow_price > 0 and follow_price < 1),   -- the price a follower could take when the card was published
  follow_price_at  timestamptz not null,
  fair             numeric,
  fair_current     boolean,
  agrees           boolean,
  wallets          jsonb not null default '[]'::jsonb,
  grade_run_id     uuid,
  check (commence_time > published_at),
  check (follow_price_at <= published_at)
);
-- H-RADAR-02 (rules version 2): a card is published at the order book's best ask, the price a subscriber can really
-- take, with the depth at it, the midpoint and the market's fee schedule at that moment (follow_price is the ask)
alter table public.radar_cards add column if not exists rules_version integer not null default 1;
alter table public.radar_cards add column if not exists ask_price     numeric check (ask_price is null or (ask_price > 0 and ask_price < 1));
alter table public.radar_cards add column if not exists ask_size      numeric check (ask_size is null or ask_size >= 0);
alter table public.radar_cards add column if not exists bid_price     numeric check (bid_price is null or (bid_price > 0 and bid_price < 1));
alter table public.radar_cards add column if not exists mid_price     numeric check (mid_price is null or (mid_price > 0 and mid_price < 1));
alter table public.radar_cards add column if not exists quoted_at     timestamptz;
alter table public.radar_cards add column if not exists fee_schedule  jsonb;
alter table public.radar_cards add column if not exists fee_per_share numeric check (fee_per_share is null or fee_per_share >= 0);   -- the market's taker fee at the ask
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'radar_cards_v2_at_the_ask') then
    alter table public.radar_cards add constraint radar_cards_v2_at_the_ask
      check (rules_version < 2 or (ask_price is not null and follow_price = ask_price and quoted_at is not null and quoted_at <= published_at));
  end if;
end $c$;
-- one record entry per game and side: the first time it was published
create unique index if not exists radar_cards_once_idx on public.radar_cards (event_id, token_id);
create index if not exists radar_cards_start_idx on public.radar_cards (commence_time);

-- ---------------------------------------------------------------- the grades (append-only, once)
create table if not exists public.radar_card_results (
  card_id       bigint primary key references public.radar_cards (card_id),
  graded_at     timestamptz not null default now(),
  result        text not null check (result in ('win', 'loss', 'push', 'void')),
  settle        numeric check (settle is null or settle in (0, 0.5, 1)),
  roi           numeric,                       -- one unit at the published price, held to settlement: settle / (follow_price + fee_per_share) - 1
  close_status  text not null check (close_status in ('graded', 'no_close', 'void')),
  close_price   numeric check (close_price is null or (close_price >= 0 and close_price <= 1)),
  close_at      timestamptz,
  beat_close    boolean,                       -- the close above the published price
  clv_pct       numeric,                       -- close / follow_price - 1 (the house formula)
  check ((result = 'void') = (settle is null)),
  check ((result = 'void') = (roi is null)),
  check (result <> 'void' or close_status = 'void'),
  check ((close_status = 'graded') = (close_price is not null)),
  check (result = 'void' or result = case settle when 1 then 'win' when 0 then 'loss' else 'push' end)
);
-- a grade is the database's arithmetic on the card's own numbers, or it is refused
create or replace function public.radar_card_results_guard()
returns trigger language plpgsql as $g$
declare c public.radar_cards;
begin
  select * into c from public.radar_cards where card_id = new.card_id;
  if not found then raise exception 'radar_card_results: no card %', new.card_id; end if;
  if c.commence_time > now() then raise exception 'radar_card_results: card %''s game has not started', new.card_id; end if;
  if new.roi is not null and abs(new.roi - (new.settle / (c.follow_price + coalesce(c.fee_per_share, 0)) - 1)) > 1e-6 then raise exception 'radar_card_results: roi must be settle / (follow price + its fee) - 1'; end if;
  if new.close_price is not null and new.beat_close is distinct from (new.close_price > c.follow_price) then raise exception 'radar_card_results: beat_close must be close > follow price'; end if;
  if new.close_price is not null and (new.clv_pct is null or abs(new.clv_pct - (new.close_price / c.follow_price - 1)) > 1e-6) then raise exception 'radar_card_results: clv_pct must be close / follow price - 1'; end if;
  if new.close_price is not null and new.beat_close is null then raise exception 'radar_card_results: a close needs its beat_close'; end if;
  if new.close_at is not null and (new.close_at > c.commence_time or new.close_at < c.commence_time - make_interval(mins => public.radar_rule('close_max_gap_min')::int)) then
    raise exception 'radar_card_results: the close must be the last price at or before the start, at most % minutes before it', public.radar_rule('close_max_gap_min');
  end if;
  return new;
end $g$;
drop trigger if exists radar_card_results_guard on public.radar_card_results;
create trigger radar_card_results_guard before insert on public.radar_card_results for each row execute function public.radar_card_results_guard();

select public.radar_seal(array['radar_cards', 'radar_card_results']);
comment on table public.radar_cards is 'Prediction Radar: every Smart Money Tonight card, as published, with the price a follower could take then. Append-only: the record is never edited.';
comment on table public.radar_card_results is 'Prediction Radar: each card graded once against the close and the result. Append-only.';

-- ---------------------------------------------------------------- publishing: the cards subscribers saw
-- Version 1 (H-RADAR-01): at the recorded price. Version 2 (H-RADAR-02): only with a quote from the order book for the
-- card's token (p_quotes, from polymarket_sync), at its best ask, with the market's taker fee at that ask
-- (radar_taker_fee, from the market's own schedule): a card whose fee is unknown is not published, never guessed.
drop function if exists public.radar_publish_cards();
create or replace function public.radar_publish_cards(p_quotes jsonb default null)
returns integer language plpgsql security definer set search_path = public, pg_temp as $f$
declare n integer := 0; v int := coalesce(public.radar_rule('rules_version'), 1)::int;
begin
  if not public.radar_enabled() or not public.radar_registered() then return 0; end if;
  if v < 2 then
    insert into public.radar_cards (event_id, sport_key, condition_id, token_id, market_type, selection, outcome, point, home_team, away_team, commence_time,
                                    n_wallets, dollars, avg_entry, follow_price, follow_price_at, fair, fair_current, agrees, wallets, grade_run_id, rules_version)
    select c ->> 'event_id', c ->> 'sport_key', c ->> 'condition_id', c ->> 'token_id', c ->> 'market_type', c ->> 'selection', c ->> 'outcome', (c ->> 'point')::numeric,
           c ->> 'home_team', c ->> 'away_team', (c ->> 'commence_time')::timestamptz, (c ->> 'n_wallets')::int, (c ->> 'dollars')::numeric, (c ->> 'avg_entry')::numeric,
           (c ->> 'current_price')::numeric, (c ->> 'price_at')::timestamptz, (c ->> 'fair')::numeric, (c ->> 'fair_current')::boolean, (c ->> 'agrees')::boolean,
           coalesce(c -> 'wallets', '[]'::jsonb), public.radar_current_run(), 1
      from public.radar_tonight_cards() c
     where (c ->> 'current_price')::numeric > 0 and (c ->> 'current_price')::numeric < 1 and (c ->> 'commence_time')::timestamptz > now()
    on conflict (event_id, token_id) do nothing;
  else
    insert into public.radar_cards (event_id, sport_key, condition_id, token_id, market_type, selection, outcome, point, home_team, away_team, commence_time,
                                    n_wallets, dollars, avg_entry, follow_price, follow_price_at, fair, fair_current, agrees, wallets, grade_run_id,
                                    rules_version, ask_price, ask_size, bid_price, mid_price, quoted_at, fee_schedule, fee_per_share)
    select c ->> 'event_id', c ->> 'sport_key', c ->> 'condition_id', c ->> 'token_id', c ->> 'market_type', c ->> 'selection', c ->> 'outcome', (c ->> 'point')::numeric,
           c ->> 'home_team', c ->> 'away_team', (c ->> 'commence_time')::timestamptz, (c ->> 'n_wallets')::int, (c ->> 'dollars')::numeric, (c ->> 'avg_entry')::numeric,
           (q ->> 'best_ask')::numeric, (q ->> 'quoted_at')::timestamptz, (c ->> 'fair')::numeric, (c ->> 'fair_current')::boolean, (c ->> 'agrees')::boolean,
           coalesce(c -> 'wallets', '[]'::jsonb), public.radar_current_run(),
           v, (q ->> 'best_ask')::numeric, (q ->> 'ask_size')::numeric, (q ->> 'best_bid')::numeric,
           case when (q ->> 'best_bid') is not null then ((q ->> 'best_bid')::numeric + (q ->> 'best_ask')::numeric) / 2 end,
           (q ->> 'quoted_at')::timestamptz, m.fee_schedule, public.radar_taker_fee((q ->> 'best_ask')::numeric, m.fee_schedule, m.fees_enabled)
      from public.radar_tonight_cards() c
      join lateral (select x from jsonb_array_elements(coalesce(p_quotes, '[]'::jsonb)) x where x ->> 'token_id' = c ->> 'token_id' limit 1) qq(q) on true
      join public.poly_markets m on m.condition_id = c ->> 'condition_id'
     where (q ->> 'best_ask')::numeric > 0 and (q ->> 'best_ask')::numeric < 1 and (q ->> 'quoted_at')::timestamptz <= now()
       and (q ->> 'quoted_at')::timestamptz > now() - make_interval(mins => public.radar_rule('holders_fresh_min')::int)
       and (c ->> 'commence_time')::timestamptz > now()
       and public.radar_taker_fee((q ->> 'best_ask')::numeric, m.fee_schedule, m.fees_enabled) is not null
    on conflict (event_id, token_id) do nothing;
  end if;
  get diagnostics n = row_count;
  return n;
end $f$;

-- ---------------------------------------------------------------- grading: the close and the result, once
create or replace function public.radar_grade_cards()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $f$
declare r record; s numeric; cp numeric; ca timestamptz; gap interval := make_interval(mins => public.radar_rule('close_max_gap_min')::int); n int := 0; v int := 0;
begin
  for r in
    select c.*, m.settle as m_settle, m.token_ids, m.closed
      from public.radar_cards c join public.poly_markets m on m.condition_id = c.condition_id
     where c.commence_time <= now()
       and not exists (select 1 from public.radar_card_results x where x.card_id = c.card_id)
       and (m.settle is not null or c.commence_time < now() - interval '7 days')
     order by c.card_id
  loop
    if r.m_settle is null then
      -- no resolution a week after the start: void, counted, never graded
      insert into public.radar_card_results (card_id, result, settle, roi, close_status) values (r.card_id, 'void', null, null, 'void');
      v := v + 1;
      continue;
    end if;
    s := (r.m_settle ->> (select (i - 1)::int from jsonb_array_elements_text(r.token_ids) with ordinality t(tok, i) where tok = r.token_id))::numeric;
    if s is null or s not in (0, 0.5, 1) then
      insert into public.radar_card_results (card_id, result, settle, roi, close_status) values (r.card_id, 'void', null, null, 'void');
      v := v + 1;
      continue;
    end if;
    cp := null; ca := null;
    select p.price, p.captured_at into cp, ca from public.poly_price_snapshots p
     where p.token_id = r.token_id and p.captured_at <= r.commence_time and p.captured_at >= r.commence_time - gap
     order by p.captured_at desc limit 1;
    insert into public.radar_card_results (card_id, result, settle, roi, close_status, close_price, close_at, beat_close, clv_pct)
    values (r.card_id, case s when 1 then 'win' when 0 then 'loss' else 'push' end, s, s / (r.follow_price + coalesce(r.fee_per_share, 0)) - 1,
            case when cp is null then 'no_close' else 'graded' end, cp, ca,
            case when cp is null then null else cp > r.follow_price end,
            case when cp is null then null else cp / r.follow_price - 1 end);
    n := n + 1;
  end loop;
  return jsonb_build_object('graded', n, 'void', v);
end $f$;

-- ---------------------------------------------------------------- the record, for subscribers
create or replace function public.radar_record(p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $f$
declare h jsonb; t jsonb; minn numeric := public.radar_rule('validation_min_followed'); v int := coalesce(public.radar_rule('rules_version'), 1)::int;
begin
  if not public.radar_enabled() then return jsonb_build_object('status', 'disabled'); end if;
  if not public.radar_registered() then return jsonb_build_object('status', 'not_registered'); end if;
  if not public.radar_is_subscriber() then return jsonb_build_object('status', 'subscribers_only'); end if;
  h := (select value::jsonb from public.radar_config where key = 'h_radar_01_result');
  -- the record counts the live rules' cards (H-RADAR-02's, at the ask); the earlier rules' cards are counted apart
  select jsonb_build_object(
      'cards', (select count(*) from public.radar_cards where rules_version = v),
      'graded', count(*) filter (where x.result <> 'void'),
      'wins', count(*) filter (where x.result = 'win'), 'losses', count(*) filter (where x.result = 'loss'), 'pushes', count(*) filter (where x.result = 'push'),
      'void', count(*) filter (where x.result = 'void'),
      'units', round(coalesce(sum(x.roi), 0), 4),
      'roi', round(avg(x.roi) filter (where x.result <> 'void'), 4),
      'beat_close_rate', round(avg(case when x.beat_close then 1.0 else 0.0 end) filter (where x.close_status = 'graded'), 4),
      'with_close', count(*) filter (where x.close_status = 'graded'),
      'no_close', count(*) filter (where x.close_status = 'no_close'),
      'pending', (select count(*) from public.radar_cards c where c.rules_version = v and not exists (select 1 from public.radar_card_results r where r.card_id = c.card_id)))
    into t
    from public.radar_card_results x join public.radar_cards cc on cc.card_id = x.card_id and cc.rules_version = v;
  return jsonb_build_object('status', 'ok', 'as_of', now(),
    -- EXPERIMENTAL until H-RADAR-01 has passed its registered criteria; a small sample until 200 graded cards
    'label', 'EXPERIMENTAL', 'hypothesis', public.radar_hypothesis(), 'rules_version', v, 'priced_at', case when v >= 2 then 'best_ask' else 'recorded_price' end,
    'small_sample', coalesce((t ->> 'graded')::int, 0) < minn, 'min_sample', minn,
    'totals', t, 'h_radar_01', h,
    'earlier_cards', (select count(*) from public.radar_cards where rules_version <> v),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('card_id', c.card_id, 'published_at', c.published_at, 'commence_time', c.commence_time, 'home_team', c.home_team,
        'away_team', c.away_team, 'market_type', c.market_type, 'outcome', c.outcome, 'selection', c.selection, 'point', c.point, 'n_wallets', c.n_wallets,
        'follow_price', c.follow_price, 'ask_size', c.ask_size, 'mid_price', c.mid_price, 'close_price', x.close_price, 'beat_close', x.beat_close, 'result', x.result, 'roi', round(x.roi, 4)) order by c.commence_time desc, c.card_id desc)
      from (select * from public.radar_cards where rules_version = v order by commence_time desc, card_id desc limit greatest(1, least(coalesce(p_limit, 50), 200))) c
      left join public.radar_card_results x on x.card_id = c.card_id), '[]'::jsonb));
end $f$;

do $g$ begin
  execute 'revoke all on function public.radar_publish_cards(jsonb), public.radar_grade_cards() from public, anon, authenticated';
  execute 'revoke all on function public.radar_record(integer) from public';
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.radar_publish_cards(jsonb), public.radar_grade_cards(), public.radar_record(integer) to service_role';
  end if;
end $g$;
-- the door (subscribers only; the database decides)
grant execute on function public.radar_record(integer) to anon, authenticated;

notify pgrst, 'reload schema';
commit;

-- THE REPORT. Every row should say ok.
select piece, state from (
  select '1 the record is append-only (update, delete and truncate refused)' as piece,
         case when (select count(*) from pg_trigger g join pg_class c on c.oid = g.tgrelid where c.relname in ('radar_cards', 'radar_card_results')
                     and g.tgname in ('radar_cards_frozen', 'radar_cards_no_truncate', 'radar_card_results_frozen', 'radar_card_results_no_truncate')) = 4 then 'ok' else 'CHECK THIS' end as state
  union all select '2 no client reads a card or a grade but through radar_record()',
         case when not exists (select 1 from pg_class where relnamespace = 'public'::regnamespace and relname in ('radar_cards', 'radar_card_results')
               and (has_table_privilege('anon', oid, 'select') or has_table_privilege('authenticated', oid, 'select'))) then 'ok' else 'CHECK THIS' end
  union all select '3 one entry per game and side',
         case when exists (select 1 from pg_indexes where indexname = 'radar_cards_once_idx') then 'ok' else 'CHECK THIS' end
) r order by 1;
