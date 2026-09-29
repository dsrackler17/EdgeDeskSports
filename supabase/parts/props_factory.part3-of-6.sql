-- props_factory -- part 3 of 6.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

create or replace function props.record_freeze() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'props.prop_record: entries are never deleted' using errcode = 'restrict_violation'; end if;
  -- everything EdgeDesk said before kickoff is frozen
  if (new.entry_id, new.frozen_at, new.league, new.season, new.game_id, new.kickoff_utc, new.player_id, new.market_key, new.side, new.line, new.sportsbook, new.american,
      new.lineage, new.model_prob, new.market_prob, new.edge, new.fair_american, new.ev, new.conservative_ev, new.confidence, new.data_quality, new.decision,
      new.stake_units, new.model_version, new.feature_version, new.prediction_id)
     is distinct from
     (old.entry_id, old.frozen_at, old.league, old.season, old.game_id, old.kickoff_utc, old.player_id, old.market_key, old.side, old.line, old.sportsbook, old.american,
      old.lineage, old.model_prob, old.market_prob, old.edge, old.fair_american, old.ev, old.conservative_ev, old.confidence, old.data_quality, old.decision,
      old.stake_units, old.model_version, old.feature_version, old.prediction_id) then
    raise exception 'props.prop_record: a frozen entry cannot be rewritten' using errcode = 'restrict_violation';
  end if;
  -- the grade is written once
  if old.result is not null and (new.result, new.actual, new.units, new.units_flat, new.clv_price, new.clv_line, new.graded_at)
       is distinct from (old.result, old.actual, old.units, old.units_flat, old.clv_price, old.clv_line, old.graded_at) then
    raise exception 'props.prop_record: a grade is written once' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists props_record_freeze on props.prop_record;
create trigger props_record_freeze before update or delete on props.prop_record for each row execute function props.record_freeze();

-- ===========================================================================
-- 11. SERVING — the distribution arithmetic, identical to football/props/factory/dist.js
-- ===========================================================================
-- P(Y <= x) for a stored distribution {t:'pmf'|'cdf'|'bern', …}
create or replace function props.dist_cdf(d jsonb, x numeric) returns numeric
language plpgsql immutable as $$
declare
  t text := d->>'t'; n int; k int; s numeric := 0; i int; xs numeric; xe numeric; ps numeric; pe numeric;
begin
  if d is null or x is null then return null; end if;
  if t = 'pmf' then
    if x < 0 then return 0; end if;
    n := jsonb_array_length(d->'v');
    k := floor(x + 0.000000001)::int;
    if k >= n then return 1; end if;
    for i in 0..k loop s := s + (d->'v'->>i)::numeric; end loop;
    return least(1, greatest(0, s));
  elsif t = 'cdf' then
    n := jsonb_array_length(d->'x');
    if x < (d->'x'->>0)::numeric then return 0; end if;
    if x >= (d->'x'->>(n - 1))::numeric then return 1; end if;
    for i in 0..n - 2 loop
      xs := (d->'x'->>i)::numeric; xe := (d->'x'->>(i + 1))::numeric;
      if x >= xs and x < xe then
        ps := (d->'p'->>i)::numeric; pe := (d->'p'->>(i + 1))::numeric;
        if xe = xs then return pe; end if;
        return ps + (pe - ps) * (x - xs) / (xe - xs);
      end if;
    end loop;
    return 1;
  elsif t = 'bern' then
    if x < 0 then return 0; elsif x < 1 then return 1 - (d->>'p')::numeric; else return 1; end if;
  end if;
  return null;
end $$;

-- {over, under, push} at a line: whole-number lines carry a push on integer stats
create or replace function props.dist_probs(d jsonb, line numeric, out p_over numeric, out p_under numeric, out p_push numeric)
language plpgsql immutable as $$
declare t text := d->>'t'; is_int boolean; k numeric; below numeric; atbelow numeric;
begin
  if d is null then return; end if;
  if t = 'bern' then p_over := (d->>'p')::numeric; p_under := 1 - p_over; p_push := 0; return; end if;
  if line is null then return; end if;
  is_int := t = 'pmf' or coalesce((d->>'int')::boolean, false);
  if is_int and line = round(line) then
    k := round(line);
    if t = 'pmf' then below := props.dist_cdf(d, k - 1); atbelow := props.dist_cdf(d, k);
    else below := props.dist_cdf(d, k - 0.5); atbelow := props.dist_cdf(d, k + 0.5); end if;
    p_under := below; p_push := greatest(0, atbelow - below);
  else
    if t = 'pmf' then p_under := props.dist_cdf(d, floor(line)); else p_under := props.dist_cdf(d, line); end if;
    p_push := 0;
  end if;
  p_over := greatest(0, 1 - p_under - p_push);
end $$;

create or replace function props.american_to_decimal(a int) returns numeric
language sql immutable as $$ select case when a is null or abs(a) < 100 then null when a > 0 then 1 + a / 100.0 else 1 + 100.0 / (-a) end $$;
create or replace function props.fair_american(p_win numeric, p_push numeric default 0) returns int
language sql immutable as $$
  select case when p_win is null or p_win <= 0 or p_win >= 1 then null
    else case when (1 - coalesce(p_push,0)) / p_win >= 2 then round(((1 - coalesce(p_push,0)) / p_win - 1) * 100)::int
              else round(-100 / ((1 - coalesce(p_push,0)) / p_win - 1))::int end end $$;

-- observed quotes only: the one dataset a backtest or a calibration may read
create or replace view props.v_observed_prop_quotes with (security_invoker = true) as
select * from props.fact_prop_quote where lineage = 'observed';

-- observed, taken before kickoff, pair-sane: the training / calibration view (Q006, Q007, Q012)
create or replace view props.v_training_prop_quotes with (security_invoker = true) as
select q.* from props.fact_prop_quote q join props.dim_game g on g.game_id = q.game_id
where q.lineage = 'observed' and q.snapshot_at < g.kickoff_utc and not q.pair_hold_out_of_bounds;

-- The board's building blocks run as their owner (security_invoker = false):
-- a view nested in the owner-run board would otherwise be checked against the
-- reader. None of them widens access — each is granted only to the roles that
-- may already read the tables beneath it.
-- the latest observed pregame quote per book / side / line
create or replace view props.v_latest_prop_quotes with (security_invoker = false) as
with latest as (
  select distinct on (q.game_id, q.player_id, q.market_key, q.sportsbook, q.side, coalesce(q.line, -9999), q.is_alt_line) q.*
  from props.fact_prop_quote q join props.dim_game g on g.game_id = q.game_id
  where q.lineage = 'observed' and q.snapshot_at < g.kickoff_utc
  order by q.game_id, q.player_id, q.market_key, q.sportsbook, q.side, coalesce(q.line, -9999), q.is_alt_line, q.snapshot_at desc
), listing as (
  select distinct on (game_id, player_id, market_key, sportsbook) game_id, player_id, market_key, sportsbook, keys
  from props.fact_prop_listing order by game_id, player_id, market_key, sportsbook, snapshot_at desc
)
select l.* from latest l
left join listing li on li.game_id = l.game_id and li.player_id = l.player_id and li.market_key = l.market_key and li.sportsbook = l.sportsbook
-- a listed book shows only what its latest poll listed; a book with no listing on file shows its latest rows
where li.keys is null or (l.side || '|' || coalesce(trim_scale(l.line)::text, '') || '|' || case when l.is_alt_line then '1' else '0' end) = any (li.keys);

-- line shopping: consensus main line, depth, dispersion, best prices and best numbers
create or replace view props.v_prop_line_shopping with (security_invoker = false) as
with main as (
  select * from props.v_latest_prop_quotes where is_main_line
), per_book as (
  select game_id, player_id, market_key, sportsbook, max(line) filter (where side = 'over') as book_line,
         max(no_vig_prob) filter (where side in ('over','yes')) as book_over_nv
  from main group by game_id, player_id, market_key, sportsbook
), cons as (
  select game_id, player_id, market_key, count(*) as book_count,
         percentile_cont(0.5) within group (order by book_line) as consensus_line,
         max(book_line) - min(book_line) as line_dispersion,
         stddev_samp(book_over_nv) as price_dispersion
  from per_book group by game_id, player_id, market_key
)
select c.*,
  (select jsonb_build_object('sportsbook', m.sportsbook, 'line', m.line, 'american', m.american_price) from main m
     where m.game_id = c.game_id and m.player_id = c.player_id and m.market_key = c.market_key and m.side in ('over','yes')
     order by m.line asc nulls last, m.decimal_price desc limit 1) as best_over_line,
  (select jsonb_build_object('sportsbook', m.sportsbook, 'line', m.line, 'american', m.american_price) from main m
     where m.game_id = c.game_id and m.player_id = c.player_id and m.market_key = c.market_key and m.side in ('under','no')
     order by m.line desc nulls last, m.decimal_price desc limit 1) as best_under_line,
  (select jsonb_build_object('sportsbook', m.sportsbook, 'line', m.line, 'american', m.american_price) from main m
     where m.game_id = c.game_id and m.player_id = c.player_id and m.market_key = c.market_key and m.side in ('over','yes')
       and (m.line is null or m.line = c.consensus_line) order by m.decimal_price desc limit 1) as best_over_price,
  (select jsonb_build_object('sportsbook', m.sportsbook, 'line', m.line, 'american', m.american_price) from main m
     where m.game_id = c.game_id and m.player_id = c.player_id and m.market_key = c.market_key and m.side in ('under','no')
       and (m.line is null or m.line = c.consensus_line) order by m.decimal_price desc limit 1) as best_under_price
from cons c;

-- movement: opener, current and close of the main over line per book
create or replace view props.v_prop_movement with (security_invoker = false) as
with q as (
  select q.*, g.kickoff_utc from props.fact_prop_quote q join props.dim_game g on g.game_id = q.game_id
  where q.lineage = 'observed' and q.is_main_line and q.side in ('over','yes')
)
select game_id, player_id, market_key, sportsbook,
  (array_agg(line order by snapshot_at))[1] as open_line,
  (array_agg(american_price order by snapshot_at))[1] as open_price,
  min(snapshot_at) as open_at,
  (array_agg(line order by snapshot_at desc))[1] as current_line,
  (array_agg(american_price order by snapshot_at desc))[1] as current_price,
  max(snapshot_at) as current_at,
  (array_agg(line order by snapshot_at desc) filter (where snapshot_at < kickoff_utc))[1] as close_line,
  (array_agg(american_price order by snapshot_at desc) filter (where snapshot_at < kickoff_utc))[1] as close_price,
  (array_agg(line order by snapshot_at desc))[1] - (array_agg(line order by snapshot_at))[1] as line_move,
  count(*) as n_snapshots
from q group by game_id, player_id, market_key, sportsbook;

-- the newest prediction per player-market-game from a CHAMPION model
create or replace view props.v_latest_predictions with (security_invoker = false) as
select distinct on (p.game_id, p.player_id, p.market_key) p.*
from props.model_prediction p join props.v_model_status s on s.model_version = p.model_version and s.status = 'CHAMPION'
order by p.game_id, p.player_id, p.market_key, p.scored_at desc;

-- every latest observed quote priced against the latest prediction's distribution
create or replace view props.v_prop_quote_eval with (security_invoker = false) as
select q.quote_id, q.league, q.game_id, q.player_id, q.market_key, q.sportsbook, q.side, q.line, q.american_price, q.decimal_price, q.implied_prob, q.no_vig_prob,
  q.is_main_line, q.is_alt_line, q.snapshot_at, p.prediction_id, p.model_version, p.projected_mean, p.projected_median, p.confidence, p.data_quality,
  case q.side when 'over' then pr.p_over when 'under' then pr.p_under when 'yes' then pr.p_over else pr.p_under end as model_win,
  pr.p_push as model_push,
  case when q.side in ('over','yes') then pr.p_over / nullif(pr.p_over + pr.p_under, 0) else pr.p_under / nullif(pr.p_over + pr.p_under, 0) end as model_prob,
  props.fair_american(case q.side when 'over' then pr.p_over when 'under' then pr.p_under when 'yes' then pr.p_over else pr.p_under end, pr.p_push) as fair_american,
  (case q.side when 'over' then pr.p_over when 'under' then pr.p_under when 'yes' then pr.p_over else pr.p_under end) * (q.decimal_price - 1)
    - (case q.side when 'over' then pr.p_under when 'under' then pr.p_over when 'yes' then pr.p_under else pr.p_over end) as expected_value
from props.v_latest_prop_quotes q
join props.v_latest_predictions p on p.game_id = q.game_id and p.player_id = q.player_id and p.market_key = q.market_key
cross join lateral props.dist_probs(p.dist, q.line) pr;

-- THE WEBSITE BOARD (workbook sheet 09): one row per player-market with the
-- best over price at the consensus line, the model and the market side by side
-- Owner-run on purpose (the pattern of cfb_lab_public_record): it exposes only
-- these curated columns, so a reader may see the board without reading the raw
-- quote history or the prediction table it is built from.
create or replace view props.v_player_props_board with (security_invoker = false) as
select p.league, p.game_id, g.kickoff_utc, p.player_id, dp.full_name as player_name, dp.position, p.market_key,
  bo.sportsbook, bo.line, bo.american_price as price,
  p.projected_mean as model_mean, p.projected_median as model_median,
  coalesce(e.model_prob, p.over_probability) as model_over_prob,
  ls.consensus_over_nv as market_no_vig_over_prob,
  coalesce(e.model_prob, p.over_probability) - ls.consensus_over_nv as edge_prob,
  e.expected_value as expected_value_pct,
  coalesce(e.fair_american, p.fair_over_american) as fair_price,
  p.confidence, p.data_quality, mv.line_move, ls.book_count,
  greatest(p.scored_at, bo.snapshot_at) as updated_at,
  p.model_version
from props.v_latest_predictions p
join props.dim_game g on g.game_id = p.game_id
join props.dim_player dp on dp.player_id = p.player_id
left join lateral (
  select l.*, (select percentile_cont(0.5) within group (order by q2.no_vig_prob) from props.v_latest_prop_quotes q2
     where q2.game_id = p.game_id and q2.player_id = p.player_id and q2.market_key = p.market_key and q2.is_main_line and q2.side in ('over','yes')
       and (q2.line is null or q2.line = l.consensus_line)) as consensus_over_nv
  from props.v_prop_line_shopping l where l.game_id = p.game_id and l.player_id = p.player_id and l.market_key = p.market_key) ls on true
left join lateral (
  select q.* from props.v_latest_prop_quotes q where q.game_id = p.game_id and q.player_id = p.player_id and q.market_key = p.market_key
    and q.side in ('over','yes') and q.is_main_line and (q.line is null or q.line = ls.consensus_line) order by q.decimal_price desc limit 1) bo on true
left join props.v_prop_quote_eval e on e.quote_id = bo.quote_id
left join lateral (select avg(m.line_move) as line_move from props.v_prop_movement m where m.game_id = p.game_id and m.player_id = p.player_id and m.market_key = p.market_key) mv on true
where g.kickoff_utc > now() - interval '6 hours';

-- the graded record by segment; bad segments are never folded away
create or replace view props.v_prop_record_summary with (security_invoker = false) as
select league, market_key, position,
  case when edge is null then null when edge < 0 then 'negative' when edge < 0.02 then '0-2%' when edge < 0.04 then '2-4%' when edge < 0.06 then '4-6%'
       when edge < 0.08 then '6-8%' when edge < 0.10 then '8-10%' else '10%+' end as edge_bucket,
  count(*) as entries,
  count(*) filter (where result is not null) as graded,
  count(*) filter (where result = 'WIN') as wins, count(*) filter (where result = 'LOSS') as losses,
  count(*) filter (where result = 'PUSH') as pushes, count(*) filter (where result = 'VOID') as voids,
  round(sum(units_flat) filter (where result in ('WIN','LOSS','PUSH')), 3) as units_flat,
  round(sum(units_flat) filter (where result in ('WIN','LOSS','PUSH')) / nullif(count(*) filter (where result in ('WIN','LOSS','PUSH')), 0), 4) as roi_flat,
  round(avg(clv_price), 4) as mean_clv_price,
  count(*) filter (where result is not null) >= 100 as sufficient_sample
from props.prop_record group by 1, 2, 3, 4;
