-- portfolio_decision -- part 2 of 9.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- EDGE CAPTURE (edge_capture_v1). Prices are decimal odds for a sportsbook
-- and contract prices (0-1) for a prediction market; the reference is the
-- decision-time price (the snapshot's, else the journal's research price).
-- Every number is + when it favours the reader. What cannot be computed is
-- null, with the reason in "limitations".
create or replace function public.portfolio_edge_capture(p_platform_type text, p_position_type text, p_dir text, p_lead bigint,
    p_entry numeric, p_entry_line numeric, p_ref numeric, p_ref_line numeric, p_close numeric, p_close_line numeric, p_prob numeric)
returns jsonb language plpgsql immutable as $$
declare
  pm boolean := p_platform_type = 'PREDICTION_MARKET';
  lim text[] := array[]::text[];
  basis text; ref_same boolean; close_same boolean;
  e_dec numeric; e_ent numeric; cap numeric; slip numeric; slip_pts numeric; clv numeric; clv_pts numeric;
begin
  if p_position_type in ('PARLAY', 'SAME_GAME_PARLAY') then
    return jsonb_build_object('methodology', 'edge_capture_v1', 'basis', 'NONE', 'limitations', jsonb_build_array('PARLAY_NOT_DECOMPOSED'));
  end if;
  if p_entry is null then
    return jsonb_build_object('methodology', 'edge_capture_v1', 'basis', 'NONE', 'limitations', jsonb_build_array('NO_ENTRY_PRICE'));
  end if;
  if p_lead is not null and p_lead <= 0 then
    return jsonb_build_object('methodology', 'edge_capture_v1', 'basis', 'NONE', 'limitations', jsonb_build_array('LIVE_ENTRY'));
  end if;
  /* a price recorded without a line is at the entry's line (the journal's
     convention: a line has moved only when both lines are known and differ) */
  ref_same := p_ref is not null and (p_ref_line is null or p_entry_line is null or p_ref_line = p_entry_line);
  close_same := p_close is not null and (p_close_line is null or p_entry_line is null or p_close_line = p_entry_line);
  basis := case when pm then 'CONTRACT'
                when (p_ref is not null and not ref_same) or (p_close is not null and not close_same) then 'POINTS'
                else 'PRICE' end;
  if ref_same then e_dec := public.portfolio_model_ev(p_platform_type, p_prob, p_ref); end if;
  e_ent := public.portfolio_model_ev(p_platform_type, p_prob, p_entry);
  if e_dec is not null and e_dec > 0 and e_ent is not null then cap := public.portfolio_div_round(e_ent, e_dec, 4); end if;
  if ref_same then slip := public.portfolio_price_slip(p_platform_type, p_entry, p_ref);
  elsif p_ref is not null then slip_pts := public.portfolio_line_gain(p_dir, p_entry_line, p_ref_line); end if;
  if close_same then clv := public.portfolio_clv_pct(p_platform_type, p_entry, p_close);
  elsif p_close is not null then clv_pts := public.portfolio_line_gain(p_dir, p_entry_line, p_close_line); end if;
  if p_prob is null then lim := lim || 'NO_MODEL_PROBABILITY'::text; end if;
  if p_ref is null then lim := lim || 'NO_DECISION_PRICE'::text; end if;
  if p_close is null then lim := lim || 'NO_CLOSE'::text; end if;
  if pm then lim := lim || 'CONTRACT_PRICE_IS_PROBABILITY'::text; else lim := lim || 'IMPLIED_PROBABILITY_INCLUDES_MARGIN'::text; end if;
  if basis = 'POINTS' then lim := lim || 'POINTS_NOT_CONVERTED_TO_PROBABILITY'::text; end if;
  if p_position_type = 'PLAYER_PROP' then lim := lim || 'PROP_MARKET_THIN'::text; end if;
  return jsonb_strip_nulls(jsonb_build_object('methodology', 'edge_capture_v1', 'basis', basis,
    'edge_at_decision', e_dec, 'edge_at_entry', e_ent, 'capture_ratio', cap,
    'slip_pct', slip, 'slip_points', slip_pts, 'clv_pct', clv, 'clv_points', clv_pts)) || jsonb_build_object('limitations', to_jsonb(lim));
end $$;

-- typed reads of a client document: a value of the wrong type or out of
-- range is dropped, never coerced
create or replace function public.portfolio_j_num(j jsonb, k text, lo numeric, hi numeric)
returns numeric language sql immutable as $$
  select case when jsonb_typeof(j->k) = 'number' and (j->>k)::numeric between lo and hi then (j->>k)::numeric
              when jsonb_typeof(j->k) = 'string' and (j->>k) ~ '^[+-]?[0-9]+(\.[0-9]+)?$' and (j->>k)::numeric between lo and hi then (j->>k)::numeric end
$$;
create or replace function public.portfolio_j_text(j jsonb, k text, maxlen int)
returns text language sql immutable as $$
  select case when jsonb_typeof(j->k) = 'string' and length(btrim(j->>k)) between 1 and maxlen then btrim(j->>k) end
$$;
create or replace function public.portfolio_j_ts(j jsonb, k text)
returns timestamptz language sql stable as $$
  select case when jsonb_typeof(j->k) = 'string' then public.portfolio_try_timestamptz(j->>k) end
$$;
create or replace function public.portfolio_j_american(j jsonb, k text)
returns int language sql immutable as $$
  select case when x is not null and x = trunc(x) and (x <= -100 or x >= 100) and abs(x) <= 1000000 then x::int end
    from (select public.portfolio_j_num(j, k, -1000000, 1000000) as x) q
$$;

-- what EdgeDesk's research said, as the client observed it: listed keys only
create or replace function public.portfolio_snapshot_edgedesk(j jsonb)
returns jsonb language sql stable as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'model_version', public.portfolio_j_text(j, 'model_version', 60),
    'calibration_version', public.portfolio_j_text(j, 'calibration_version', 60),
    'pricing_version', public.portfolio_j_text(j, 'pricing_version', 60),
    'engine', public.portfolio_j_text(j, 'engine', 60),
    'research_id', public.portfolio_j_text(j, 'research_id', 120),
    'probability', public.portfolio_j_num(j, 'probability', 0.000001, 0.999999),
    'probability_source', public.portfolio_j_text(j, 'probability_source', 40),
    'fair_odds_decimal', public.portfolio_j_num(j, 'fair_odds_decimal', 1.000001, 10001),
    'fair_line', public.portfolio_j_num(j, 'fair_line', -1000, 1000),
    'ev', public.portfolio_j_num(j, 'ev', -1, 100),
    'edge_pp', public.portfolio_j_num(j, 'edge_pp', -100, 100),
    'confidence', public.portfolio_j_num(j, 'confidence', 0, 100),
    'decision', case when j->>'decision' in ('BET', 'LEAN', 'WATCH', 'PASS', 'NO_DECISION') then j->>'decision' end,
    'stage', public.portfolio_j_text(j, 'stage', 40),
    'evaluated_at', public.portfolio_j_ts(j, 'evaluated_at')))
$$;
-- the market as the client observed it, each price with its capture time
create or replace function public.portfolio_snapshot_market(j jsonb)
returns jsonb language sql stable as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'captured_at', public.portfolio_j_ts(j, 'captured_at'),
    'source', public.portfolio_j_text(j, 'source', 60),
    'sig_key', public.portfolio_j_text(j, 'sig_key', 200),
    'book', public.portfolio_j_text(j, 'book', 60),
    'odds_american', public.portfolio_j_american(j, 'odds_american'),
    'odds_decimal', coalesce(public.portfolio_american_to_decimal(public.portfolio_j_american(j, 'odds_american')),
                             public.portfolio_j_num(j, 'odds_decimal', 1.000001, 10001)),
    'price', public.portfolio_j_num(j, 'price', 0.000001, 0.999999),
    'line', public.portfolio_j_num(j, 'line', -1000, 1000),
    'consensus_decimal', public.portfolio_j_num(j, 'consensus_decimal', 1.000001, 10001),
    'consensus_probability', public.portfolio_j_num(j, 'consensus_probability', 0.000001, 0.999999),
    'consensus_line', public.portfolio_j_num(j, 'consensus_line', -1000, 1000),
    'n_books', public.portfolio_j_num(j, 'n_books', 0, 200)::int,
    'range_min_decimal', public.portfolio_j_num(j, 'range_min_decimal', 1.000001, 10001),
    'range_max_decimal', public.portfolio_j_num(j, 'range_max_decimal', 1.000001, 10001),
    'range_min_line', public.portfolio_j_num(j, 'range_min_line', -1000, 1000),
    'range_max_line', public.portfolio_j_num(j, 'range_max_line', -1000, 1000),
    'books', (select jsonb_agg(b) from (
        select jsonb_strip_nulls(jsonb_build_object('book', public.portfolio_j_text(x, 'book', 60),
                 'odds_american', public.portfolio_j_american(x, 'odds_american'),
                 'odds_decimal', coalesce(public.portfolio_american_to_decimal(public.portfolio_j_american(x, 'odds_american')),
                                          public.portfolio_j_num(x, 'odds_decimal', 1.000001, 10001)),
                 'line', public.portfolio_j_num(x, 'line', -1000, 1000), 'captured_at', public.portfolio_j_ts(x, 'captured_at'))) as b
          from jsonb_array_elements(case when jsonb_typeof(j->'books') = 'array' then j->'books' else '[]'::jsonb end) with ordinality e(x, i)
         where jsonb_typeof(x) = 'object' and public.portfolio_j_text(x, 'book', 60) is not null and i <= 30) q)))
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. DECISION SNAPSHOTS — immutable, one per position, before the event
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.portfolio_decision_snapshots (
  position_id       uuid        primary key,
  user_id           uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  origin            text        not null,
  origin_ref        text        null,
  saved_at          timestamptz null,
  recorded_at       timestamptz not null default now(),
  snapshot_version  text        not null default 'snapshot_v1',
  edgedesk          jsonb       not null default '{}'::jsonb,
  market            jsonb       not null default '{}'::jsonb,
  user_state        jsonb       not null default '{}'::jsonb,
  market_freshness  text        not null default 'UNKNOWN',
  content_hash      text        not null default '',
  constraint portfolio_snapshot_position_fk foreign key (position_id, user_id)
    references public.portfolio_positions (id, user_id) on delete cascade,
  constraint portfolio_snapshot_origin check (origin in ('CARD', 'RESEARCH', 'MANUAL')),
  constraint portfolio_snapshot_text check (coalesce(length(origin_ref), 0) <= 120),
  constraint portfolio_snapshot_json check (jsonb_typeof(edgedesk) = 'object' and jsonb_typeof(market) = 'object'
    and jsonb_typeof(user_state) = 'object' and pg_column_size(edgedesk) + pg_column_size(market) + pg_column_size(user_state) <= 32768),
  constraint portfolio_snapshot_freshness check (market_freshness in ('FRESH', 'AGING', 'STALE', 'FUTURE', 'UNKNOWN'))
);
comment on table public.portfolio_decision_snapshots is
  'IMMUTABLE. What EdgeDesk, the market and the reader''s own state were when a position was recorded, before the event. Never updated by anyone; goes only with its position.';
create index if not exists portfolio_snapshots_user on public.portfolio_decision_snapshots (user_id, recorded_at desc);

-- the reader's own state at the decision, computed here from their records
create or replace function public.portfolio_user_state(p_user uuid, p_position uuid, p_placed timestamptz)
returns jsonb language plpgsql stable as $$
declare u record; day_n int; day_cost numeric; r jsonb; x jsonb;
begin
  select * into u from public.portfolio_unit_snapshot(p_user);
  select count(*), coalesce(sum(p.cost_basis), 0) into day_n, day_cost from public.portfolio_positions p
   where p.user_id = p_user and p.id <> p_position and p.placed_at <= p_placed and p.placed_at > p_placed - interval '24 hours';
  select coalesce(jsonb_agg(jsonb_build_object('id', r0.id, 'kind', r0.kind, 'label', r0.label) order by r0.label), '[]'::jsonb) into r
    from public.portfolio_rules r0 where r0.user_id = p_user and r0.active_from <= p_placed and (r0.active_until is null or r0.active_until > p_placed);
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'title', e.title, 'metric', e.metric, 'ends_at', e.ends_at) order by e.starts_at), '[]'::jsonb) into x
    from public.portfolio_experiments e where e.user_id = p_user and e.status = 'ACTIVE' and e.starts_at <= p_placed and e.ends_at > p_placed;
  return jsonb_strip_nulls(jsonb_build_object('unit', u.unit, 'bankroll', u.bankroll, 'max_single_units', u.max_single, 'max_daily_units', u.max_daily,
    'prior_24h_positions', day_n, 'prior_24h_cost', day_cost,
    'prior_24h_units', case when u.unit > 0 then round(day_cost / u.unit, 4) end,
    'rules', r, 'experiments', x));
end $$;

create or replace function public.portfolio_snapshot_guard() returns trigger
language plpgsql as $$
declare p record; reader boolean := auth.uid() is not null;
begin
  if tg_op = 'UPDATE' then
    raise exception 'portfolio: a decision snapshot is never rewritten' using errcode = '42501',
      hint = 'It records what was known when the position was entered. Add a review note instead.';
  end if;
  if reader then new.user_id := auth.uid(); end if;
  new.recorded_at := now();
  new.snapshot_version := 'snapshot_v1';
  select id, user_id, placed_at, event_start_at, status into p from public.portfolio_positions where id = new.position_id and user_id = new.user_id;
  if not found then raise exception 'portfolio: no such position' using errcode = 'P0002'; end if;
  /* a snapshot is the moment of the decision, not a reconstruction */
  if p.status <> 'OPEN' or (p.event_start_at is not null and new.recorded_at >= p.event_start_at)
     or new.recorded_at > p.placed_at + interval '6 hours' then
    raise exception 'portfolio: a decision snapshot is taken when the position is recorded, before the event — not after the fact'
      using errcode = '22023';
  end if;
  new.origin := upper(coalesce(new.origin, 'MANUAL'));
  new.origin_ref := nullif(btrim(new.origin_ref), '');
  if new.saved_at is not null and (new.saved_at > new.recorded_at + interval '5 minutes' or new.saved_at < new.recorded_at - interval '400 days') then
    new.saved_at := null;
  end if;
  new.edgedesk := public.portfolio_snapshot_edgedesk(coalesce(new.edgedesk, '{}'::jsonb));
  new.market := public.portfolio_snapshot_market(coalesce(new.market, '{}'::jsonb));
  new.user_state := public.portfolio_user_state(new.user_id, new.position_id, p.placed_at);
  new.market_freshness := public.portfolio_freshness((new.market->>'captured_at')::timestamptz, new.recorded_at);
  new.content_hash := public.portfolio_sha256(jsonb_build_object('position_id', new.position_id, 'origin', new.origin, 'origin_ref', new.origin_ref,
    'saved_at', new.saved_at, 'recorded_at', new.recorded_at, 'version', new.snapshot_version, 'edgedesk', new.edgedesk,
    'market', new.market, 'user_state', new.user_state)::text);
  return new;
end $$;
drop trigger if exists portfolio_snapshot_guard_trg on public.portfolio_decision_snapshots;
create trigger portfolio_snapshot_guard_trg before insert or update on public.portfolio_decision_snapshots
  for each row execute function public.portfolio_snapshot_guard();

-- the snapshot fills the journal's DECISION block where it is still empty
-- (the journal stays write-once: nothing recorded is replaced), puts the
-- decision and entry prices on the market path, and marks the Card entry
-- recorded. Runs as the caller (the journal's own guard applies).
create or replace function public.portfolio_snapshot_after() returns trigger
language plpgsql as $$
declare e jsonb := new.edgedesk; m jsonb := new.market; cap timestamptz := (new.market->>'captured_at')::timestamptz;
begin
  update public.portfolio_journal_entries j set
         decision_source = coalesce(j.decision_source, case when new.origin in ('CARD', 'RESEARCH') then 'EDGEDESK' else 'USER' end),
         model_version = coalesce(j.model_version, e->>'model_version'),
         model_probability = coalesce(j.model_probability, (e->>'probability')::numeric),
         model_fair_line = coalesce(j.model_fair_line, (e->>'fair_line')::numeric),
         model_fair_odds_decimal = coalesce(j.model_fair_odds_decimal, (e->>'fair_odds_decimal')::numeric),
         research_odds_american = case when coalesce(j.research_odds_decimal, j.research_price) is null and cap is not null and cap <= new.recorded_at
                                       then coalesce(j.research_odds_american, (m->>'odds_american')::int) else j.research_odds_american end,
         research_odds_decimal = case when coalesce(j.research_odds_decimal, j.research_price) is null and cap is not null and cap <= new.recorded_at
                                      then coalesce(j.research_odds_decimal, (m->>'odds_decimal')::numeric) else j.research_odds_decimal end,
         research_price = case when coalesce(j.research_odds_decimal, j.research_price) is null and cap is not null and cap <= new.recorded_at
                               then coalesce(j.research_price, (m->>'price')::numeric) else j.research_price end,
         research_line = case when j.research_line is null and cap is not null and cap <= new.recorded_at then (m->>'line')::numeric else j.research_line end,
         research_at = case when j.research_at is null and cap is not null and cap <= new.recorded_at and coalesce(m->>'odds_decimal', m->>'price') is not null
                            then cap else j.research_at end
   where j.position_id = new.position_id;
  perform public.portfolio_path_from_snapshot(new.position_id);
  if new.origin = 'CARD' and new.origin_ref is not null then
    perform public.portfolio_card_recorded(new.user_id, new.origin_ref, new.position_id, e->>'decision');
  end if;
  return null;
end $$;
drop trigger if exists portfolio_snapshot_after_trg on public.portfolio_decision_snapshots;
create trigger portfolio_snapshot_after_trg after insert on public.portfolio_decision_snapshots
  for each row execute function public.portfolio_snapshot_after();
