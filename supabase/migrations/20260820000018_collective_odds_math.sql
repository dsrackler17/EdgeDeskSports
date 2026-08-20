-- Model Collective, migration 18: moneyline capture, best price, consensus.
--
-- Three pieces of market arithmetic that are easy to get subtly wrong, so
-- they live in one place with the reasoning written down:
--
--   1. Best price compares like with like. A price is only better than
--      another if it is on the SAME line. Chiefs -4 at -105 is not "better"
--      than Chiefs -3.5 at -110; it is a different bet. Comparing across
--      lines needs a model of what a half point is worth, which is a
--      judgement call, so this refuses to make it silently.
--   2. Consensus lines are medians, never means. One book hanging an
--      outlier should not drag the number.
--   3. Consensus probability de-vigs each book first. Averaging American
--      prices averages the bookmaker's margin along with the opinion.
--
-- Pinnacle is kept out of the generic consensus and reported separately, so
-- a sharp reference is never diluted by the rest of the market.

alter table collective.market_snapshots
  add column if not exists home_ml_price int,
  add column if not exists away_ml_price int;

-- American price to implied probability, vig included.
create or replace function collective.american_to_prob(p int) returns numeric
language sql immutable as $$
  select case
    when p is null then null
    when p < 0 then (-p)::numeric / ((-p)::numeric + 100)
    when p > 0 then 100::numeric / (p::numeric + 100)
    else null end
$$;

-- American price to decimal, which is the only sane way to rank prices:
-- higher decimal is always the better price for the bettor.
create or replace function collective.american_to_decimal(p int) returns numeric
language sql immutable as $$
  select case
    when p is null then null
    when p < 0 then 1 + 100::numeric / (-p)::numeric
    when p > 0 then 1 + p::numeric / 100
    else null end
$$;

-- Two-way de-vig: strip the bookmaker's margin proportionally so the pair
-- sums to 1. Returns the fair probability of the FIRST side.
create or replace function collective.devig_two_way(p1 int, p2 int) returns numeric
language sql immutable as $$
  select case
    when p1 is null or p2 is null then null
    when (collective.american_to_prob(p1) + collective.american_to_prob(p2)) = 0 then null
    else collective.american_to_prob(p1)
         / (collective.american_to_prob(p1) + collective.american_to_prob(p2))
  end
$$;

-- Latest snapshot per game per book, the input to both views below.
create or replace view collective.latest_by_book as
select distinct on (ms.game_id, ms.book)
  ms.game_id, ms.book, ms.source, ms.captured_at,
  ms.home_line, ms.home_price, ms.away_line, ms.away_price,
  ms.total_line, ms.over_price, ms.under_price,
  ms.home_ml_price, ms.away_ml_price
from collective.market_snapshots ms
where ms.market = 'spread'
order by ms.game_id, ms.book, ms.captured_at desc;

-- Consensus, with Pinnacle deliberately excluded and reported on its own.
create or replace view collective.market_consensus as
with pin as (
  select game_id, home_line as pin_home_line, home_price as pin_home_price,
         collective.devig_two_way(home_ml_price, away_ml_price) as pin_home_fair
  from collective.latest_by_book where lower(book) = 'pinnacle'
),
rest as (
  select
    game_id,
    count(*)                                            as books,
    percentile_cont(0.5) within group (order by home_line)  as consensus_home_line,
    percentile_cont(0.5) within group (order by total_line) as consensus_total,
    avg(collective.devig_two_way(home_ml_price, away_ml_price)) as consensus_home_fair,
    max(captured_at)                                    as latest_capture
  from collective.latest_by_book
  where lower(book) is distinct from 'pinnacle'
  group by game_id
)
select
  coalesce(rest.game_id, pin.game_id)                   as game_id,
  coalesce(rest.books, 0)                               as books,
  rest.consensus_home_line, rest.consensus_total, rest.consensus_home_fair,
  pin.pin_home_line, pin.pin_home_price, pin.pin_home_fair,
  rest.latest_capture
from rest full outer join pin on pin.game_id = rest.game_id;

-- Best price for one side of the spread, reported PER LINE. The caller
-- decides which line it wants; nothing here pretends a different line is
-- comparable.
create or replace function collective.best_spread_price(p_game_id uuid, p_side text)
returns table (line numeric, book text, price int, decimal_odds numeric, books_at_line int)
language sql stable as $$
  with s as (
    select case when p_side = 'home' then home_line else away_line end as ln,
           case when p_side = 'home' then home_price else away_price end as pr,
           book
    from collective.latest_by_book
    where game_id = p_game_id
  ), ranked as (
    select ln, book, pr,
           collective.american_to_decimal(pr) as dec,
           count(*) over (partition by ln) as n,
           row_number() over (partition by ln order by collective.american_to_decimal(pr) desc) as rk
    from s where ln is not null and pr is not null
  )
  select ln, book, pr, dec, n::int from ranked where rk = 1 order by ln
$$;

grant select on collective.latest_by_book, collective.market_consensus to service_role;

-- The write path predates the moneyline columns above, so it never stored
-- them. Same function, two more fields.
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
        r->>'sport', nullif(r->>'season','')::int,
        r->>'home_team', r->>'away_team', nullif(r->>'kickoff','')::timestamptz);
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
        total_line, over_price, under_price,
        home_ml_price, away_ml_price, captured_at, source)
      values (
        v_game, r->>'sport', coalesce(nullif(r->>'market',''), 'spread'), r->>'book',
        nullif(r->>'home_line','')::numeric, nullif(r->>'home_price','')::int,
        nullif(r->>'away_line','')::numeric, nullif(r->>'away_price','')::int,
        nullif(r->>'total_line','')::numeric, nullif(r->>'over_price','')::int,
        nullif(r->>'under_price','')::int,
        nullif(r->>'home_ml_price','')::int, nullif(r->>'away_ml_price','')::int,
        v_cap, coalesce(nullif(r->>'source',''), 'unknown'));
      n_ok := n_ok + 1;
    exception
      when unique_violation then n_dup := n_dup + 1;
      when others then n_bad := n_bad + 1;
    end;
  end loop;

  return jsonb_build_object('ok', true, 'stored', n_ok, 'duplicates', n_dup,
    'unmatched', n_unmatched, 'rejected', n_bad, 'unmatched_rows', v_unmatched);
end $$;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='collective' and p.proname='record_market_snapshots' loop
    execute format('revoke execute on function %s from public', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
