-- ============================================================================
-- EDGEDESK — VERIFIED P&L on model_pnl. docs/pnl/DESIGN.md § Verified P&L
-- Apply after model_pnl.sql, model_pnl_states.sql, model_pnl_analytics.sql;
-- it supersedes model_pnl_derive() and model_pnl_upsert(), so re-apply it
-- after re-applying model_pnl.sql (its report says when that is needed).
--   · NO PRICE = NO VERIFIED P&L. pnl_verified is true only for a decision
--     settled W/L/P at a valid price that existed at or before the decision;
--     every other row carries ONE pnl_exclusion_reason. Derived by trigger.
--   · a price captured after the decision is PRICE_AFTER_DECISION, never P&L.
--   · stake_source: 'explicit' (the decision's own stake) or 'default' (a
--     model number priced by its stored pre-decision quote, at the default).
--   · THE PRICE LOCK: a row with no price may receive one ONCE (price_source
--     'snapshot', price_ref = the stored quote); then it is frozen like the rest.
--   · verified_pnl_* : the decisions, summary, breakdowns, cumulative series
--     and the integrity checks, aggregated here, never on the page.
-- Idempotent and additive; ends in a report whose rows must all read ok.
-- ============================================================================
do $g$ begin
  if to_regclass('public.model_pnl') is null then raise exception 'apply supabase/model_pnl.sql first'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'model_pnl' and column_name = 'record_state') then
    raise exception 'apply supabase/model_pnl_states.sql first'; end if;
end $g$;

alter table public.model_pnl add column if not exists stake_source text null;
alter table public.model_pnl add column if not exists price_source text null;
alter table public.model_pnl add column if not exists price_ref jsonb null;
alter table public.model_pnl add column if not exists price_lookup jsonb null;
alter table public.model_pnl add column if not exists price_locked_at timestamptz null;
alter table public.model_pnl add column if not exists pnl_verified boolean not null default false;
alter table public.model_pnl add column if not exists pnl_exclusion_reason text null;

alter table public.model_pnl drop constraint if exists model_pnl_enums;
alter table public.model_pnl add constraint model_pnl_enums check (
  source in ('player_props', 'bettor_decision', 'model_record') and market_group in ('game', 'prop')
  and market_type in ('spread', 'total', 'moneyline', 'player_prop') and (side is null or side in ('home', 'away', 'over', 'under'))
  and rec_class in ('BET', 'LEAN', 'WATCH', 'PASS', 'MODEL') and evaluation_mode in ('LIVE', 'LIVE_RECONSTRUCTED')
  and result in ('win', 'loss', 'push', 'void', 'pending')
  and pnl_status in ('VERIFIED', 'PENDING', 'VOID', 'NO_ENTRY_PRICE', 'SIMULATED_PRICE', 'INVALID_PRICE', 'INVALID_STAKE', 'PRICE_AFTER_DECISION'));
alter table public.model_pnl drop constraint if exists model_pnl_stake_valid;
alter table public.model_pnl add constraint model_pnl_stake_valid check (
  stake_units >= 0 and stake_units <= 100 and (rec_class = 'BET' or stake_units = 0 or (stake_source = 'default' and rec_class in ('MODEL', 'LEAN'))));

create or replace function public.model_pnl_derive() returns trigger language plpgsql as $t$
declare
  frozen text[] := array['source', 'league', 'event_id', 'market_type', 'prop_market', 'player_id', 'side', 'selection', 'model_line',
    'entry_line', 'price_assumed', 'model_prob', 'model_edge_pct', 'rec_class', 'model_version', 'recommended_at', 'evaluation_mode', 'game_date'];
  locked text[] := array['entry_odds', 'entry_odds_raw', 'entry_book', 'odds_captured_at', 'stake_units', 'stake_source', 'price_source', 'price_ref'];
  settle text[] := array['result', 'result_value', 'final_score', 'closing_line', 'closing_odds', 'clv_points', 'clv_prob_pp', 'beat_close'];
  o jsonb; n jsonb; k text; diff jsonb := '{}'::jsonb; locking boolean := false;
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
  new.stake_source := case when new.stake_units > 0 then case when new.stake_source = 'default' then 'default' else 'explicit' end end;
  new.price_source := case when new.entry_odds is null and new.entry_odds_raw is null and not new.price_assumed then null
    when new.price_source = 'snapshot' then 'snapshot' else 'decision' end;
  if new.price_source is distinct from 'snapshot' then new.price_ref := null; end if;
  new.implied_prob := case when new.entry_odds is null then null
    else round(1 / (case when new.entry_odds > 0 then 1 + new.entry_odds / 100 else 1 + 100 / abs(new.entry_odds) end), 4) end;
  new.missing_entry_odds := new.entry_odds is null and new.entry_odds_raw is null and not new.price_assumed;
  new.pnl_status := case
    when new.price_assumed then 'SIMULATED_PRICE'
    when new.entry_odds is null and new.entry_odds_raw is not null then 'INVALID_PRICE'
    when new.entry_odds is null then case when new.result = 'pending' then 'PENDING' else 'NO_ENTRY_PRICE' end
    when new.odds_captured_at > new.recommended_at then 'PRICE_AFTER_DECISION'
    when new.result = 'pending' then 'PENDING'
    when new.result = 'void' then 'VOID'
    else 'VERIFIED' end;
  if new.pnl_status in ('VERIFIED', 'VOID') then
    new.flat_profit_units := public.edp_pnl_profit(new.entry_odds, 1, new.result);
    new.profit_units := case when new.stake_units > 0 then public.edp_pnl_profit(new.entry_odds, new.stake_units, new.result) end;
  else new.flat_profit_units := null; new.profit_units := null; end if;
  if tg_op = 'INSERT' and new.price_source = 'snapshot' then new.price_locked_at := coalesce(new.price_locked_at, now()); end if;
  if tg_op = 'UPDATE' then
    o := to_jsonb(old); n := to_jsonb(new);
    foreach k in array frozen loop
      if (o -> k) is distinct from (n -> k) then
        raise exception 'model_pnl: % is part of the recommendation and is frozen (row %)', k, old.recommendation_id;
      end if;
    end loop;
    -- the price lock: a row with no price may receive one ONCE
    locking := old.entry_odds is null and old.entry_odds_raw is null and not old.price_assumed and new.entry_odds is not null;
    if locking then new.price_locked_at := coalesce(new.price_locked_at, now());
    else
      foreach k in array locked loop
        if (o -> k) is distinct from (n -> k) and not (k in ('stake_source', 'price_source') and coalesce(o -> k, 'null'::jsonb) = 'null'::jsonb) then
          raise exception 'model_pnl: % is part of the locked price and is frozen (row %)', k, old.recommendation_id;
        end if;
      end loop;
      new.price_locked_at := old.price_locked_at;
    end if;
    foreach k in array settle loop
      if (o -> k) is distinct from (n -> k) then diff := diff || jsonb_build_object(k, jsonb_build_object('from', o -> k, 'to', n -> k)); end if;
    end loop;
    if diff <> '{}'::jsonb or locking then new.updated_at := now(); end if;
    if diff <> '{}'::jsonb and old.result <> 'pending' and (diff ? 'result' or exists (select 1 from jsonb_each(diff) d where d.value -> 'from' <> 'null'::jsonb)) then
      insert into public.model_pnl_corrections (recommendation_id, changed, reason)
      values (new.recommendation_id, diff, coalesce(new.last_correction_reason, 'the source settlement changed'));
      new.corrected := true;
      new.correction_count := old.correction_count + 1;
    end if;
  end if;
  return new;
end $t$;

-- after the state (triggers fire in name order: derive < state < verify)
create or replace function public.model_pnl_verify() returns trigger language plpgsql as $v$
begin
  new.pnl_verified := new.record_state = 'VERIFIED';
  new.pnl_exclusion_reason := case
    when new.record_state = 'VERIFIED' then null
    when new.record_state = 'PENDING' then 'missing_settlement'
    when new.record_state = 'VOID' then 'void'
    when new.record_state = 'INVALID' then case when new.state_reason like '%not a result%' then 'missing_settlement'
      when new.state_reason like '%after the game started%' then 'recommended_after_start' else 'missing_selection' end
    when new.pnl_status = 'SIMULATED_PRICE' then 'simulated_price'
    when new.pnl_status = 'INVALID_PRICE' then 'invalid_odds'
    when new.pnl_status = 'INVALID_STAKE' then 'missing_stake'
    when new.pnl_status = 'PRICE_AFTER_DECISION' then 'price_after_decision'
    when new.price_lookup ->> 'status' in ('historical_price_unavailable', 'price_after_decision') then new.price_lookup ->> 'status'
    else 'missing_price' end;
  return new;
end $v$;
drop trigger if exists model_pnl_verify_trg on public.model_pnl;
create trigger model_pnl_verify_trg before insert or update on public.model_pnl for each row execute function public.model_pnl_verify();

-- the one writer, as before, plus the price lock and the lookup's reason
create or replace function public.model_pnl_upsert(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $u$
declare
  e jsonb; r public.model_pnl; cur public.model_pnl;
  ins int := 0; upd int := 0; locks int := 0; same int := 0; refused jsonb := '[]'::jsonb;
begin
  for e in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    begin
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
        insert into public.model_pnl_corrections (recommendation_id, corrected_at, changed, reason)
        select r.recommendation_id, coalesce((c ->> 'at')::timestamptz, now()), coalesce(c -> 'fields', '{}'::jsonb), c ->> 'reason'
        from jsonb_array_elements(case when jsonb_typeof(e -> 'corrections') = 'array' then e -> 'corrections' else '[]'::jsonb end) c;
        ins := ins + 1;
      elsif (cur.result, cur.result_value, cur.final_score, cur.closing_line, cur.closing_odds, cur.clv_points, cur.clv_prob_pp, cur.beat_close, cur.settled_at)
            is distinct from (r.result, r.result_value, r.final_score, r.closing_line, r.closing_odds, r.clv_points, r.clv_prob_pp, r.beat_close, r.settled_at)
         or (cur.entry_odds is null and cur.entry_odds_raw is null and not cur.price_assumed and r.entry_odds is not null)
         or cur.price_lookup is distinct from r.price_lookup then
        if cur.entry_odds is null and cur.entry_odds_raw is null and not cur.price_assumed and r.entry_odds is not null then locks := locks + 1; end if;
        update public.model_pnl set
          result = r.result, result_value = r.result_value, final_score = r.final_score, closing_line = r.closing_line, closing_odds = r.closing_odds,
          clv_points = r.clv_points, clv_prob_pp = r.clv_prob_pp, beat_close = r.beat_close, settled_at = r.settled_at,
          last_correction_reason = r.last_correction_reason, price_lookup = r.price_lookup,
          source = r.source, league = r.league, event_id = r.event_id, market_type = r.market_type, prop_market = r.prop_market, player_id = r.player_id,
          side = r.side, selection = r.selection, model_line = r.model_line, entry_line = r.entry_line, entry_odds = r.entry_odds, entry_odds_raw = r.entry_odds_raw,
          entry_book = r.entry_book, price_assumed = r.price_assumed, model_prob = r.model_prob, model_edge_pct = r.model_edge_pct, rec_class = r.rec_class,
          stake_units = r.stake_units, stake_source = r.stake_source, price_source = r.price_source, price_ref = r.price_ref, price_locked_at = r.price_locked_at,
          model_version = r.model_version, recommended_at = r.recommended_at, odds_captured_at = r.odds_captured_at,
          evaluation_mode = r.evaluation_mode, game_date = r.game_date
        where recommendation_id = r.recommendation_id;
        upd := upd + 1;
      else same := same + 1; end if;
    exception when others then
      refused := refused || jsonb_build_object('recommendation_id', e ->> 'recommendation_id', 'error', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('inserted', ins, 'updated', upd, 'price_locked', locks, 'unchanged', same, 'refused', refused);
end $u$;

-- every row already stored gets its stake source, price source and verification now
update public.model_pnl set updated_at = updated_at where true;

do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'model_pnl_verified_rules') then
    alter table public.model_pnl add constraint model_pnl_verified_rules check (
      (stake_source is null or (stake_source in ('explicit', 'default') and stake_units > 0))
      and (price_source is null or price_source in ('decision', 'snapshot'))
      and pnl_verified = (record_state = 'VERIFIED')
      and (pnl_verified or pnl_exclusion_reason in ('missing_settlement', 'missing_price', 'historical_price_unavailable', 'price_after_decision',
        'invalid_odds', 'simulated_price', 'missing_stake', 'missing_selection', 'recommended_after_start', 'void'))
      and (not pnl_verified or (pnl_exclusion_reason is null and abs(entry_odds) >= 100 and result in ('win', 'loss', 'push')
        and not (odds_captured_at > recommended_at)))
      and (price_source is distinct from 'snapshot' or (price_ref ->> 'event_id' = event_id and odds_captured_at is not null and price_locked_at is not null)));
  end if;
end $c$;
create index if not exists model_pnl_verified_idx on public.model_pnl (pnl_verified, league, market_type, game_date);
create index if not exists model_pnl_sport_idx on public.model_pnl (sport);

revoke all on function public.model_pnl_upsert(jsonb) from public, anon, authenticated;
grant execute on function public.model_pnl_upsert(jsonb) to service_role;

notify pgrst, 'reload schema';

-- THE REPORT.
select piece, state from (
  select 'the derive trigger is the verified one (re-apply this file after model_pnl.sql)' as piece,
    case when (select prosrc from pg_proc where oid = 'public.model_pnl_derive()'::regprocedure) like '%price lock%' then 'ok' else 'CHECK THIS' end as state
  union all select 'the upsert is the verified one (it locks a price once)', case when (select prosrc from pg_proc where oid = 'public.model_pnl_upsert(jsonb)'::regprocedure) like '%price_locked%' then 'ok' else 'CHECK THIS' end
  union all select 'verification derived by trigger, after the state', case when exists (select 1 from pg_trigger where tgname = 'model_pnl_verify_trg') and 'model_pnl_state_trg' < 'model_pnl_verify_trg' then 'ok' else 'CHECK THIS' end
  union all select 'verified = settled at a valid price that existed at the decision (constraint)', case when exists (select 1 from pg_constraint where conname = 'model_pnl_verified_rules') then 'ok' else 'CHECK THIS' end
  union all select 'every row is verified or carries one exclusion reason', case when not exists (select 1 from public.model_pnl where not pnl_verified and pnl_exclusion_reason is null) then 'ok' else 'CHECK THIS' end
  union all select 'no verified row was priced after its decision', case when not exists (select 1 from public.model_pnl where pnl_verified and odds_captured_at > recommended_at) then 'ok' else 'CHECK THIS' end
  union all select 'no verified row without a valid price', case when not exists (select 1 from public.model_pnl where pnl_verified and (entry_odds is null or abs(entry_odds) < 100)) then 'ok' else 'CHECK THIS' end
  union all select 'profit to 6 places (-110 → 0.909091, +150 → 1.5, -200 → 0.5, 0.5u at +150 → 0.75, 0.5u at -115 → 0.434783)',
    case when public.edp_pnl_profit(-110, 1, 'win') = 0.909091 and public.edp_pnl_profit(150, 1, 'win') = 1.5 and public.edp_pnl_profit(-200, 1, 'win') = 0.5
      and public.edp_pnl_profit(150, 0.5, 'win') = 0.75 and public.edp_pnl_profit(-115, 0.5, 'win') = 0.434783 and public.edp_pnl_profit(-110, 1, 'loss') = -1 then 'ok' else 'CHECK THIS' end
  union all select 'only the service role writes', case when not has_function_privilege('anon', 'public.model_pnl_upsert(jsonb)', 'execute') then 'ok' else 'CHECK THIS' end
) r order by 1;
