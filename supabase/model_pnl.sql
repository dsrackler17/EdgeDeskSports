-- ============================================================================
-- EDGEDESK — model_pnl: profit and loss of EdgeDesk's own recommendations.
-- docs/pnl/DESIGN.md has the full account; the rules, in short:
--   · one row per recommendation_id (the primary key): settling twice writes
--     one row. Written only by model_pnl_upsert() (service role), fed by
--     tools/record/pnl_sync.js from record/pnl/ledger_<season>.json.
--   · entry_odds is the American price recorded WHEN the recommendation was
--     made. NULL → no P&L, never an assumed −110. A malformed price is never
--     stored as odds (kept as text in entry_odds_raw → INVALID_PRICE).
--   · the P&L columns are DERIVED by trigger from the row's own price, stake
--     and result: flat_profit_units (1.00u) and profit_units (stake_units),
--     two strategies, never mixed.
--   · the recommendation half of a row is frozen by trigger; a settlement
--     that changes after it was settled is a CORRECTION, logged append-only in
--     model_pnl_corrections. Nothing is ever deleted.
--   · RLS on, no client policy; readers get model_pnl_public (public fields).
-- Idempotent and additive; ends in a report whose rows must all read ok.
-- Then run supabase/model_pnl_analytics.sql (the public view, rollups, dollars).
-- ============================================================================

create table if not exists public.model_pnl (
  recommendation_id text primary key,
  source text not null,
  source_ref jsonb null,
  sport text not null default 'football',
  league text not null,
  season int null,
  week int null,
  event_id text not null,
  event_label text null,
  home text null,
  away text null,
  game_date timestamptz null,
  model_version text null,
  engine_version text null,
  market_group text not null,
  market_type text not null,
  prop_market text null,
  prop_label text null,
  prop_category text null,
  player_id text null,
  player_name text null,
  team text null,
  opponent text null,
  position text null,
  side text null,
  selection text not null,
  model_line numeric null,
  entry_line numeric null,
  entry_odds numeric null,
  entry_odds_raw text null,
  entry_book text null,
  price_assumed boolean not null default false,
  model_prob numeric null,
  implied_prob numeric null,
  model_edge_pct numeric null,
  ev_pct numeric null,
  rec_class text not null,
  confidence numeric null,
  stake_units numeric not null default 0,
  flat_stake_units numeric not null default 1,
  recommended_at timestamptz null,
  odds_captured_at timestamptz null,
  evaluation_mode text not null default 'LIVE',
  result text not null default 'pending',
  result_value numeric null,
  final_score text null,
  closing_line numeric null,
  closing_odds numeric null,
  clv_points numeric null,
  clv_prob_pp numeric null,
  beat_close boolean null,
  settled_at timestamptz null,
  pnl_status text not null default 'PENDING',
  missing_entry_odds boolean not null default false,
  flat_profit_units numeric null,
  profit_units numeric null,
  corrected boolean not null default false,
  correction_count int not null default 0,
  last_correction_reason text     null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'model_pnl_enums') then
    alter table public.model_pnl add constraint model_pnl_enums check (
      source in ('player_props', 'bettor_decision', 'model_record')
      and market_group in ('game', 'prop')
      and market_type in ('spread', 'total', 'moneyline', 'player_prop')
      and (side is null or side in ('home', 'away', 'over', 'under'))
      and rec_class in ('BET', 'LEAN', 'WATCH', 'PASS', 'MODEL')
      and evaluation_mode in ('LIVE', 'LIVE_RECONSTRUCTED')
      and result in ('win', 'loss', 'push', 'void', 'pending')
      and pnl_status in ('VERIFIED', 'PENDING', 'VOID', 'NO_ENTRY_PRICE', 'SIMULATED_PRICE', 'INVALID_PRICE', 'INVALID_STAKE'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'model_pnl_odds_valid') then
    alter table public.model_pnl add constraint model_pnl_odds_valid check (
      (entry_odds is null or (abs(entry_odds) >= 100 and abs(entry_odds) <= 100000))
      and (closing_odds is null or (abs(closing_odds) >= 100 and abs(closing_odds) <= 100000)));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'model_pnl_stake_valid') then
    alter table public.model_pnl add constraint model_pnl_stake_valid check (
      stake_units >= 0 and stake_units <= 100 and (rec_class = 'BET' or stake_units = 0));
  end if;
  -- no captured price, no P&L
  if not exists (select 1 from pg_constraint where conname = 'model_pnl_no_invented_pnl') then
    alter table public.model_pnl add constraint model_pnl_no_invented_pnl check (
      (entry_odds is not null and not price_assumed) or (flat_profit_units is null and profit_units is null));
  end if;
end $c$;

create index if not exists model_pnl_league_idx on public.model_pnl (league, sport);
create index if not exists model_pnl_event_idx on public.model_pnl (event_id);
create index if not exists model_pnl_player_idx on public.model_pnl (player_id) where player_id is not null;
create index if not exists model_pnl_settled_idx on public.model_pnl (settled_at);
create index if not exists model_pnl_version_idx on public.model_pnl (model_version);
create index if not exists model_pnl_market_idx on public.model_pnl (market_type, prop_market);
create index if not exists model_pnl_strategy_idx on public.model_pnl (rec_class, pnl_status, game_date);

-- corrections: append-only
create table if not exists public.model_pnl_corrections (
  id bigint generated always as identity primary key,
  recommendation_id text not null references public.model_pnl (recommendation_id),
  corrected_at timestamptz not null default now(),
  changed jsonb not null,
  reason text null
);
create index if not exists model_pnl_corrections_rec_idx on public.model_pnl_corrections (recommendation_id, corrected_at);

-- the arithmetic, as lib/edgedesk_pnl.js profit(): no valid price or stake → NULL
create or replace function public.edp_pnl_profit(p_american numeric, p_stake numeric, p_result text)
returns numeric language sql immutable as $f$
  select case
    when p_american is null or abs(p_american) < 100 or abs(p_american) > 100000 then null
    when p_stake is null or p_stake < 0 then null
    when lower(coalesce(p_result, '')) in ('push', 'void') then 0
    when lower(coalesce(p_result, '')) = 'loss' then trim_scale(round(-p_stake, 4))
    when lower(coalesce(p_result, '')) = 'win' then trim_scale(round(case when p_american > 0 then p_stake * p_american / 100 else p_stake * 100 / abs(p_american) end, 4))
    else null end
$f$;

-- derive P&L, freeze the recommendation, log corrections
create or replace function public.model_pnl_derive() returns trigger language plpgsql as $t$
declare
  frozen text[] := array['source', 'league', 'event_id', 'market_type', 'prop_market', 'player_id', 'side', 'selection', 'model_line',
    'entry_line', 'entry_odds', 'entry_odds_raw', 'entry_book', 'price_assumed', 'model_prob', 'model_edge_pct', 'rec_class', 'stake_units',
    'model_version', 'recommended_at', 'odds_captured_at', 'evaluation_mode', 'game_date'];
  settle text[] := array['result', 'result_value', 'final_score', 'closing_line', 'closing_odds', 'clv_points', 'clv_prob_pp', 'beat_close'];
  o jsonb; n jsonb; k text; diff jsonb := '{}'::jsonb;
begin
  new.result := lower(coalesce(new.result, 'pending'));
  new.flat_stake_units := 1;
  new.sport := coalesce(new.sport, 'football');
  new.stake_units := coalesce(new.stake_units, 0);
  new.price_assumed := coalesce(new.price_assumed, false);
  new.evaluation_mode := coalesce(new.evaluation_mode, 'LIVE');
  new.corrected := coalesce(new.corrected, false);
  new.correction_count := coalesce(new.correction_count, 0);
  new.created_at := coalesce(new.created_at, now());
  new.updated_at := coalesce(new.updated_at, now());
  new.implied_prob := case when new.entry_odds is null then null
    else round(1 / (case when new.entry_odds > 0 then 1 + new.entry_odds / 100 else 1 + 100 / abs(new.entry_odds) end), 4) end;
  new.missing_entry_odds := new.entry_odds is null and new.entry_odds_raw is null and not new.price_assumed;
  new.pnl_status := case
    when new.price_assumed then 'SIMULATED_PRICE'
    when new.entry_odds is null and new.entry_odds_raw is not null then 'INVALID_PRICE'
    when new.entry_odds is null then case when new.result = 'pending' then 'PENDING' else 'NO_ENTRY_PRICE' end
    when new.result = 'pending' then 'PENDING'
    when new.result = 'void' then 'VOID'
    else 'VERIFIED' end;
  if new.pnl_status in ('VERIFIED', 'VOID') then
    new.flat_profit_units := public.edp_pnl_profit(new.entry_odds, 1, new.result);
    new.profit_units := case when new.stake_units > 0 then public.edp_pnl_profit(new.entry_odds, new.stake_units, new.result) end;
  else
    new.flat_profit_units := null; new.profit_units := null;
  end if;
  if tg_op = 'UPDATE' then
    o := to_jsonb(old); n := to_jsonb(new);
    foreach k in array frozen loop
      if (o -> k) is distinct from (n -> k) then
        raise exception 'model_pnl: % is part of the recommendation and is frozen (row %)', k, old.recommendation_id;
      end if;
    end loop;
    foreach k in array settle loop
      if (o -> k) is distinct from (n -> k) then diff := diff || jsonb_build_object(k, jsonb_build_object('from', o -> k, 'to', n -> k)); end if;
    end loop;
    if diff <> '{}'::jsonb then
      new.updated_at := now();
      -- a change to a settled row is a CORRECTION: logged
      if old.result <> 'pending' and (diff ? 'result' or exists (select 1 from jsonb_each(diff) d where d.value -> 'from' <> 'null'::jsonb)) then
        insert into public.model_pnl_corrections (recommendation_id, changed, reason)
        values (new.recommendation_id, diff, coalesce(new.last_correction_reason, 'the source settlement changed'));
        new.corrected := true;
        new.correction_count := old.correction_count + 1;
      end if;
    end if;
  end if;
  return new;
end $t$;
drop trigger if exists model_pnl_derive_trg on public.model_pnl;
create trigger model_pnl_derive_trg before insert or update on public.model_pnl for each row execute function public.model_pnl_derive();

-- never deleted, never edited
create or replace function public.model_pnl_keep() returns trigger language plpgsql as $k$
begin raise exception 'model_pnl: % is refused — recommendations and their corrections are kept forever', tg_op; end $k$;
drop trigger if exists model_pnl_no_delete_trg on public.model_pnl;
create trigger model_pnl_no_delete_trg before delete on public.model_pnl for each row execute function public.model_pnl_keep();
drop trigger if exists model_pnl_no_truncate_trg on public.model_pnl;
create trigger model_pnl_no_truncate_trg before truncate on public.model_pnl for each statement execute function public.model_pnl_keep();
drop trigger if exists model_pnl_corrections_frozen_trg on public.model_pnl_corrections;
create trigger model_pnl_corrections_frozen_trg before update or delete on public.model_pnl_corrections for each row execute function public.model_pnl_keep();

-- the one writer: insert a new recommendation, update a settlement that moved,
-- leave the rest; a row that would rewrite a recommendation is refused, named
create or replace function public.model_pnl_upsert(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $u$
declare
  e jsonb; r public.model_pnl; cur public.model_pnl;
  ins int := 0; upd int := 0; same int := 0; refused jsonb := '[]'::jsonb;
begin
  for e in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    begin
      -- not a real American price: never stored as odds
      if e ? 'entry_odds' and jsonb_typeof(e -> 'entry_odds') <> 'null'
         and (jsonb_typeof(e -> 'entry_odds') <> 'number' or abs((e ->> 'entry_odds')::numeric) < 100 or abs((e ->> 'entry_odds')::numeric) > 100000) then
        e := jsonb_set(e, '{entry_odds_raw}', to_jsonb(e ->> 'entry_odds')) || '{"entry_odds": null}'::jsonb;
      end if;
      r := jsonb_populate_record(null::public.model_pnl, e);
      r.last_correction_reason := coalesce(e #>> '{corrections,-1,reason}', r.last_correction_reason);
      select * into cur from public.model_pnl where recommendation_id = r.recommendation_id;
      if not found then
        r.created_at := now(); r.updated_at := now();
        r.correction_count := coalesce(jsonb_array_length(case when jsonb_typeof(e -> 'corrections') = 'array' then e -> 'corrections' end), 0);
        r.corrected := r.correction_count > 0;
        insert into public.model_pnl select (r).*;
        -- first seen already corrected: its history comes too
        insert into public.model_pnl_corrections (recommendation_id, corrected_at, changed, reason)
        select r.recommendation_id, coalesce((c ->> 'at')::timestamptz, now()), coalesce(c -> 'fields', '{}'::jsonb), c ->> 'reason'
        from jsonb_array_elements(case when jsonb_typeof(e -> 'corrections') = 'array' then e -> 'corrections' else '[]'::jsonb end) c;
        ins := ins + 1;
      elsif (cur.result, cur.result_value, cur.final_score, cur.closing_line, cur.closing_odds, cur.clv_points, cur.clv_prob_pp, cur.beat_close, cur.settled_at)
            is distinct from (r.result, r.result_value, r.final_score, r.closing_line, r.closing_odds, r.clv_points, r.clv_prob_pp, r.beat_close, r.settled_at) then
        update public.model_pnl set
          result = r.result, result_value = r.result_value, final_score = r.final_score, closing_line = r.closing_line, closing_odds = r.closing_odds,
          clv_points = r.clv_points, clv_prob_pp = r.clv_prob_pp, beat_close = r.beat_close, settled_at = r.settled_at,
          last_correction_reason = r.last_correction_reason,
          -- re-sent as stored: the trigger refuses any difference
          source = r.source, league = r.league, event_id = r.event_id, market_type = r.market_type, prop_market = r.prop_market, player_id = r.player_id,
          side = r.side, selection = r.selection, model_line = r.model_line, entry_line = r.entry_line, entry_odds = r.entry_odds, entry_odds_raw = r.entry_odds_raw,
          entry_book = r.entry_book, price_assumed = r.price_assumed, model_prob = r.model_prob, model_edge_pct = r.model_edge_pct, rec_class = r.rec_class,
          stake_units = r.stake_units, model_version = r.model_version, recommended_at = r.recommended_at, odds_captured_at = r.odds_captured_at,
          evaluation_mode = r.evaluation_mode, game_date = r.game_date
        where recommendation_id = r.recommendation_id;
        upd := upd + 1;
      else
        same := same + 1;
      end if;
    exception when others then
      refused := refused || jsonb_build_object('recommendation_id', e ->> 'recommendation_id', 'error', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('inserted', ins, 'updated', upd, 'unchanged', same, 'refused', refused);
end $u$;

alter table public.model_pnl enable row level security;
alter table public.model_pnl_corrections enable row level security;
revoke all on public.model_pnl, public.model_pnl_corrections from anon, authenticated;
revoke all on function public.model_pnl_upsert(jsonb) from public, anon, authenticated;
grant execute on function public.model_pnl_upsert(jsonb) to service_role;
grant select, insert, update on public.model_pnl, public.model_pnl_corrections to service_role;

notify pgrst, 'reload schema';

-- THE REPORT.
select piece, state from (
  select 'model_pnl table, keyed by recommendation_id' as piece, case when to_regclass('public.model_pnl') is not null and exists (select 1 from pg_constraint where conrelid = 'public.model_pnl'::regclass and contype = 'p') then 'ok' else 'CHECK THIS' end as state
  union all select 'model_pnl_corrections (append-only)', case when exists (select 1 from pg_trigger where tgname = 'model_pnl_corrections_frozen_trg') then 'ok' else 'CHECK THIS' end
  union all select 'P&L derived by trigger; recommendation half frozen', case when exists (select 1 from pg_trigger where tgname = 'model_pnl_derive_trg') then 'ok' else 'CHECK THIS' end
  union all select 'no delete, no truncate', case when (select count(*) from pg_trigger where tgname in ('model_pnl_no_delete_trg', 'model_pnl_no_truncate_trg')) = 2 then 'ok' else 'CHECK THIS' end
  union all select 'profit arithmetic (-110 → 0.9091, +150 → 1.5, -150 → 0.6667, 0 → null, push → 0)',
    case when public.edp_pnl_profit(-110, 1, 'win') = 0.9091 and public.edp_pnl_profit(150, 1, 'win') = 1.5 and public.edp_pnl_profit(-150, 1, 'win') = 0.6667
      and public.edp_pnl_profit(0, 1, 'win') is null and public.edp_pnl_profit(-110, 1, 'push') = 0 and public.edp_pnl_profit(-110, 0.5, 'loss') = -0.5 then 'ok' else 'CHECK THIS' end
  union all select 'no captured price, no P&L (constraint)', case when exists (select 1 from pg_constraint where conname = 'model_pnl_no_invented_pnl') then 'ok' else 'CHECK THIS' end
  union all select 'RLS on, no client can read the table', case when (select relrowsecurity from pg_class where oid = 'public.model_pnl'::regclass) and not has_table_privilege('anon', 'public.model_pnl', 'select') then 'ok' else 'CHECK THIS' end
  union all select 'only the service role writes', case when not has_function_privilege('anon', 'public.model_pnl_upsert(jsonb)', 'execute') and not has_function_privilege('authenticated', 'public.model_pnl_upsert(jsonb)', 'execute') then 'ok' else 'CHECK THIS' end
  union all select 'no row carries an invented P&L', case when not exists (select 1 from public.model_pnl where (entry_odds is null or price_assumed) and (flat_profit_units is not null or profit_units is not null)) then 'ok' else 'CHECK THIS' end
) r order by 1;
