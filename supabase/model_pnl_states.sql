-- ============================================================================
-- EDGEDESK — model_pnl: every recommendation's ONE state, why "pending", and
-- the canonical record. Run after supabase/model_pnl.sql (before or after
-- model_pnl_analytics.sql). docs/pnl/DESIGN.md
--   · record_state: PENDING, VERIFIED (settled at a captured entry price),
--     RECORD_ONLY (a result, no usable entry price: W-L only, never units),
--     VOID or INVALID — derived by trigger exactly as lib/edgedesk_pnl.js
--     stateOf() derives it. INVALID is also kept when the ledger build said
--     so (it saw the raw value the table cannot hold), with its reason.
--   · pending_reason: why a pending row is pending, as the ledger build placed
--     it (tools/record/pnl_core.js pendingReason). Written only by
--     model_pnl_reasons() (service role), fed by tools/record/pnl_sync.js.
--   · model_record_canonical: ONE normalized view of every recommendation —
--     the fields every figure on the Records page is defined on.
--   · model_record_states: the counts the diagnostics read.
-- Idempotent and additive; ends in a report whose rows must all read ok.
-- ============================================================================

do $g$
begin
  if to_regclass('public.model_pnl') is null then
    raise exception 'apply supabase/model_pnl.sql first';
  end if;
end $g$;

alter table public.model_pnl add column if not exists record_state text not null default 'PENDING';
alter table public.model_pnl add column if not exists state_reason text null;
alter table public.model_pnl add column if not exists pending_reason text null;

do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'model_pnl_states') then
    alter table public.model_pnl add constraint model_pnl_states check (
      record_state in ('PENDING', 'VERIFIED', 'RECORD_ONLY', 'VOID', 'INVALID')
      and (pending_reason is null or (record_state = 'PENDING' and pending_reason in ('UPCOMING', 'IN_PROGRESS', 'AWAITING_SETTLEMENT',
        'AWAITING_STAT_FEED', 'MISSING_FINAL', 'MISSING_PLAYER_STAT', 'SETTLEMENT_FAILED', 'MISSING_MAPPING', 'UNKNOWN')))
      -- verified means settled at a captured price; record only never carries units
      and (record_state <> 'VERIFIED' or (entry_odds is not null and not price_assumed and result in ('win', 'loss', 'push')))
      and (record_state <> 'RECORD_ONLY' or (flat_profit_units is null and profit_units is null)));
  end if;
end $c$;
create index if not exists model_pnl_state_idx on public.model_pnl (record_state, pending_reason);

-- the state, after model_pnl_derive_trg has set pnl_status (triggers of one
-- event fire in name order: derive < state)
create or replace function public.model_pnl_state() returns trigger language plpgsql as $s$
begin
  new.record_state := case
    when new.record_state = 'INVALID' and new.state_reason is not null then 'INVALID'
    when new.rec_class <> 'MODEL' and new.recommended_at is not null and new.game_date is not null and new.recommended_at > new.game_date then 'INVALID'
    when new.result = 'pending' then 'PENDING'
    when new.result = 'void' then 'VOID'
    when new.pnl_status = 'VERIFIED' then 'VERIFIED'
    else 'RECORD_ONLY' end;
  if new.record_state = 'INVALID' then
    new.state_reason := coalesce(new.state_reason, 'recommended after the game started');
    new.flat_profit_units := null; new.profit_units := null;   -- graded nowhere
  else new.state_reason := null; end if;
  if new.record_state <> 'PENDING' then new.pending_reason := null; end if;
  return new;
end $s$;
drop trigger if exists model_pnl_state_trg on public.model_pnl;
create trigger model_pnl_state_trg before insert or update on public.model_pnl for each row execute function public.model_pnl_state();

-- why pending (and an INVALID verdict), from the ledger build; only rows that moved
create or replace function public.model_pnl_reasons(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $r$
declare n int := 0;
begin
  with x as (
    select e ->> 'recommendation_id' as id, nullif(e ->> 'pending_reason', '') as why,
           coalesce(e ->> 'record_state', '') = 'INVALID' as bad, nullif(e ->> 'state_reason', '') as sr
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) e)
  update public.model_pnl m
     set pending_reason = x.why,
         record_state = case when x.bad then 'INVALID' else m.record_state end,
         state_reason = case when x.bad then coalesce(x.sr, 'invalid in the ledger') else null end
    from x
   where m.recommendation_id = x.id
     and (m.pending_reason is distinct from x.why or x.bad is distinct from (m.record_state = 'INVALID' and m.state_reason is not null));
  get diagnostics n = row_count;
  return jsonb_build_object('updated', n);
end $r$;

-- THE CANONICAL RECORD: one row per recommendation, normalized
create or replace view public.model_record_canonical as
select recommendation_id as id, source, sport, league, season, week, event_id as game_id, event_label, game_date as event_time,
       market_group, market_type, prop_market, player_id, player_name as player, team, side, selection,
       model_line as model_value, model_prob, model_edge_pct as edge_pct, entry_line, entry_odds, entry_book, recommended_at, odds_captured_at,
       closing_line, closing_odds, rec_class as recommendation_grade, stake_units,
       final_score as final_result, result as settlement_result, settled_at,
       profit_units as pnl_units, flat_profit_units as flat_pnl_units, clv_points as clv, beat_close,
       model_version, pnl_status, record_state, pending_reason, corrected, correction_count
from public.model_pnl
where evaluation_mode in ('LIVE', 'LIVE_RECONSTRUCTED');

create or replace view public.model_record_states as
select league, market_group, rec_class, record_state, coalesce(pending_reason, '') as pending_reason, count(*)::int as n
from public.model_pnl
where evaluation_mode in ('LIVE', 'LIVE_RECONSTRUCTED')
group by 1, 2, 3, 4, 5;

grant select on public.model_record_canonical, public.model_record_states to anon, authenticated;
revoke all on function public.model_pnl_reasons(jsonb) from public, anon, authenticated;
grant execute on function public.model_pnl_reasons(jsonb) to service_role;

-- every row already stored gets its state now (the trigger derives it)
update public.model_pnl set state_reason = state_reason where true;

notify pgrst, 'reload schema';

-- THE REPORT.
select piece, state from (
  select 'every row has exactly one state' as piece, case when not exists (select 1 from public.model_pnl where record_state not in ('PENDING', 'VERIFIED', 'RECORD_ONLY', 'VOID', 'INVALID')) then 'ok' else 'CHECK THIS' end as state
  union all select 'states derived by trigger, after the P&L', case when exists (select 1 from pg_trigger where tgname = 'model_pnl_state_trg') and 'model_pnl_derive_trg' < 'model_pnl_state_trg' then 'ok' else 'CHECK THIS' end
  union all select 'verified = settled at a captured price; record only = no units (constraint)', case when exists (select 1 from pg_constraint where conname = 'model_pnl_states') then 'ok' else 'CHECK THIS' end
  union all select 'the canonical record is public, internal fields absent', case when has_table_privilege('anon', 'public.model_record_canonical', 'select') and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'model_record_canonical' and column_name in ('entry_odds_raw', 'last_correction_reason', 'source_ref')) then 'ok' else 'CHECK THIS' end
  union all select 'only the service role writes the reasons', case when not has_function_privilege('anon', 'public.model_pnl_reasons(jsonb)', 'execute') and not has_function_privilege('authenticated', 'public.model_pnl_reasons(jsonb)', 'execute') then 'ok' else 'CHECK THIS' end
  union all select 'no settled row is left pending, no pending row settled', case when not exists (select 1 from public.model_pnl where (record_state = 'PENDING') <> (result = 'pending') and record_state <> 'INVALID') then 'ok' else 'CHECK THIS' end
) r order by 1;
