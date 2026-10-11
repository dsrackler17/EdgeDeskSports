-- =============================================================================
-- quant_desk.sql — the quant desk's ledgers: venue execution costs, the
-- adversarial audit trail, the fair-price checks and the backtest record.
--
-- WHAT IT ADDS (and what it deliberately does not)
--   market_execution_costs  operator-VERIFIED venue fee schedules. The fair-odds
--                           engine (lib/edgedesk_fairodds.js) ships Kalshi's
--                           formula as UNVERIFIED and Polymarket's as UNKNOWN; a
--                           row here, with a source and a verifier, is what turns
--                           a venue's fees VERIFIED. Readable by any signed-in
--                           reader (fee schedules are public facts); written by
--                           the service role only.
--   opportunity_audits      one write-once row per candidate the auditor
--                           (supabase/functions/edgedesk_ai/_audit.js) checked:
--                           every check, the independent recomputation, the
--                           corrections and the verdict. Graded against the close
--                           by sig_key, like research_packets.
--   fair_price_estimates    one write-once row per contract or price check the
--                           desk answered: every field the engine computes, the
--                           fair's source and observation time, the calculation
--                           version and the verdict.
--   model_backtests         the backtest and calibration record per sport,
--                           market and model version. A backtest whose training
--                           window does not end before its test window, or that
--                           recorded a look-ahead violation, cannot be stored.
--   NOT added, because the existing schema already holds it:
--     sports events / quotes      signals, book_quotes, book_quote_ticks, games
--     projections / versions      the slate artifacts, cfb_model_versions, props.model_registry
--     opportunity candidates      research_packets (one row per emitted board
--                                 opportunity and watchlist item, write-once)
--     stake decisions             stake_recommendations
--   `research_sessions` is written by edgedesk_ai but its DDL is not in this
--   repository; it is not redefined here (a guessed schema would collide).
--
-- THE RULES, ENFORCED BY THE SERVER
--   1. The two ledgers are write-once and are never deleted by a reader. The
--      retention job (quant_desk_prune, service role only) is the one door
--      that removes rows older than the retention window.
--   2. Row level security: a reader inserts and reads their own audit and
--      estimate rows; the service role reads everything.
--   3. Probabilities are in [0, 1], contract prices in (0, 100) cents,
--      American odds at least 100 in size: the unit errors the engine refuses
--      are refused here too.
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. MARKET EXECUTION COSTS — verified venue fee schedules
-- ---------------------------------------------------------------------------
create table if not exists public.market_execution_costs (
  id                 bigint generated always as identity primary key,
  venue              text not null,
  category           text not null default 'sports',
  fee_kind           text not null check (fee_kind in ('NONE','KALSHI_QUADRATIC','POLYMARKET_PARAMETRIC','COMMISSION_ON_WINNINGS','PER_CONTRACT')),
  taker_coefficient  numeric check (taker_coefficient is null or (taker_coefficient >= 0 and taker_coefficient < 1)),
  maker_coefficient  numeric check (maker_coefficient is null or (maker_coefficient >= 0 and maker_coefficient < 1)),
  rate               numeric check (rate is null or (rate >= 0 and rate < 1)),
  exponent           numeric check (exponent is null or (exponent >= 0 and exponent <= 4)),
  per_contract       numeric check (per_contract is null or (per_contract >= 0 and per_contract < 1)),
  commission         numeric check (commission is null or (commission >= 0 and commission < 1)),
  rounding           text,
  maker_fees_market  boolean not null default false,
  effective_from     timestamptz not null,
  effective_to       timestamptz,
  source_url         text not null check (source_url ~ '^https://'),
  verified_at        timestamptz not null,
  verified_by        text not null check (length(verified_by) > 0),
  notes              text,
  created_at         timestamptz not null default now(),
  constraint market_execution_costs_window check (effective_to is null or effective_to > effective_from),
  constraint market_execution_costs_params check (
    (fee_kind = 'KALSHI_QUADRATIC' and taker_coefficient is not null) or
    (fee_kind = 'POLYMARKET_PARAMETRIC' and rate is not null and exponent is not null) or
    (fee_kind = 'COMMISSION_ON_WINNINGS' and commission is not null) or
    (fee_kind = 'PER_CONTRACT' and per_contract is not null) or
    (fee_kind = 'NONE')),
  constraint market_execution_costs_once unique (venue, category, effective_from)
);
comment on table public.market_execution_costs is
  'Operator-verified venue fee schedules for the fair-odds engine. A row needs an https source and a verifier; the engine treats a venue''s fees as VERIFIED only from a row here.';
create index if not exists market_execution_costs_lookup_idx on public.market_execution_costs (venue, category, effective_from desc);

alter table public.market_execution_costs enable row level security;
drop policy if exists market_execution_costs_read on public.market_execution_costs;
create policy market_execution_costs_read on public.market_execution_costs
  for select to authenticated using (true);
grant select on public.market_execution_costs to authenticated;
do $anon$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on public.market_execution_costs from anon; end if;
end $anon$;

-- ---------------------------------------------------------------------------
-- 2. OPPORTUNITY AUDITS — the adversarial auditor's trail
-- ---------------------------------------------------------------------------
create table if not exists public.opportunity_audits (
  id                 bigint generated always as identity primary key,
  audit_id           text not null unique,
  user_id            uuid default auth.uid(),
  created_at         timestamptz not null default now(),
  audited_at         timestamptz not null,
  candidate_id       text not null,
  sport              text,
  game_id            text,
  market             text,
  selection          text,
  line               numeric,
  book               text,
  odds_american      numeric check (odds_american is null or abs(odds_american) >= 100),
  quote_captured_at  timestamptz,
  sig_key            text,
  fair_method        text,
  fair_probability   numeric check (fair_probability is null or (fair_probability > 0 and fair_probability < 1)),
  model_version      text,
  status             text not null check (status in ('CONFIRMED','DOWNGRADED','NEEDS_RECHECK','REJECTED')),
  reason             text,
  independent_ev     numeric check (independent_ev is null or (independent_ev > -1 and independent_ev < 10)),
  rounds             int not null default 1 check (rounds between 1 and 3),
  checks             jsonb not null check (jsonb_typeof(checks) = 'array'),
  recomputed         jsonb,
  corrections        jsonb,
  classification     text check (classification is null or classification in ('VERIFIED_EDGE','POTENTIAL_EDGE','WATCH','PASS','UNVERIFIED_DATA')),
  calc_version       text,
  audit_version      text,
  question           text
);
comment on table public.opportunity_audits is
  'Write-once trail of the adversarial auditor: one row per audited candidate, every check, the independent recomputation and the verdict. Graded against signals by sig_key.';
create index if not exists opportunity_audits_user_idx on public.opportunity_audits (user_id, created_at desc);
create index if not exists opportunity_audits_game_idx on public.opportunity_audits (sport, game_id, audited_at desc);
create index if not exists opportunity_audits_sig_idx on public.opportunity_audits (sig_key) where sig_key is not null;
create index if not exists opportunity_audits_status_idx on public.opportunity_audits (status, audited_at desc);

-- ---------------------------------------------------------------------------
-- 3. FAIR PRICE ESTIMATES — every contract and price check answered
-- ---------------------------------------------------------------------------
create table if not exists public.fair_price_estimates (
  id                           bigint generated always as identity primary key,
  estimate_id                  text not null unique,
  user_id                      uuid default auth.uid(),
  created_at                   timestamptz not null default now(),
  evaluated_at                 timestamptz not null,
  kind                         text not null check (kind in ('CONTRACT','WAGER')),
  venue                        text not null,
  side                         text check (side is null or side in ('YES','NO')),
  sport                        text,
  event_id                     text,
  market                       text,
  selection                    text,
  sig_key                      text,
  price_cents                  numeric check (price_cents is null or (price_cents > 0 and price_cents < 100)),
  american                     numeric check (american is null or abs(american) >= 100),
  market_probability           numeric check (market_probability is null or (market_probability >= 0 and market_probability <= 1)),
  no_vig_market_probability    numeric check (no_vig_market_probability is null or (no_vig_market_probability >= 0 and no_vig_market_probability <= 1)),
  independent_fair_probability numeric check (independent_fair_probability is null or (independent_fair_probability >= 0 and independent_fair_probability <= 1)),
  fair_probability             numeric check (fair_probability is null or (fair_probability >= 0 and fair_probability <= 1)),
  fair_kind                    text check (fair_kind is null or fair_kind in ('SHARP_NO_VIG','CONSENSUS_NO_VIG','MODEL','USER')),
  fair_label                   text,
  fair_observed_at             timestamptz,
  fair_american_odds           numeric,
  break_even_probability       numeric check (break_even_probability is null or (break_even_probability >= 0 and break_even_probability <= 1.5)),
  gross_expected_value         numeric,
  net_expected_value           numeric,
  net_ev_per_dollar            numeric,
  expected_fee_per_contract    numeric check (expected_fee_per_contract is null or expected_fee_per_contract >= 0),
  fee_status                   text check (fee_status is null or fee_status in ('VERIFIED','UNVERIFIED','UNKNOWN','OVERRIDE')),
  estimated_slippage           numeric check (estimated_slippage is null or estimated_slippage >= 0),
  maximum_entry_price          numeric,
  model_uncertainty            jsonb,
  data_freshness               jsonb,
  research_confidence          text,
  market_liquidity             text,
  calibration_status           text,
  classification               text not null check (classification in ('VERIFIED_EDGE','POTENTIAL_EDGE','WATCH','PASS','UNVERIFIED_DATA')),
  decision                     text not null check (decision in ('BUY','WATCH','PASS')),
  caps                         jsonb,
  calc_version                 text not null,
  question                     text,
  constraint fair_price_estimates_price check ((kind = 'CONTRACT' and price_cents is not null) or (kind = 'WAGER' and american is not null))
);
comment on table public.fair_price_estimates is
  'Write-once record of every contract or price check the desk answered, with the fair''s source and observation time and the calculation version.';
create index if not exists fair_price_estimates_user_idx on public.fair_price_estimates (user_id, created_at desc);
create index if not exists fair_price_estimates_event_idx on public.fair_price_estimates (sport, event_id, evaluated_at desc);
create index if not exists fair_price_estimates_sig_idx on public.fair_price_estimates (sig_key) where sig_key is not null;

-- ---------------------------------------------------------------------------
-- 4. MODEL BACKTESTS — the calibration record, chronologically separated
-- ---------------------------------------------------------------------------
create table if not exists public.model_backtests (
  id                   bigint generated always as identity primary key,
  backtest_id          text not null unique,
  created_at           timestamptz not null default now(),
  sport                text not null,
  market               text not null,
  model_version        text not null,
  method               text,
  train_from           date,
  train_to             date not null,
  test_from            date not null,
  test_to              date not null,
  n                    int not null check (n >= 0),
  brier                numeric,
  log_loss             numeric,
  baseline_brier       numeric,
  baseline_log_loss    numeric,
  baseline             text,
  clv_mean             numeric,
  roi_after_fees       numeric,
  max_drawdown         numeric,
  ci_low               numeric,
  ci_high              numeric,
  buckets              jsonb,
  by_odds_range        jsonb,
  sample_state         text check (sample_state is null or sample_state in ('TOO_EARLY','EARLY_SIGNAL','DEVELOPING','MEANINGFUL')),
  calibration_status   text check (calibration_status is null or calibration_status in ('CALIBRATED','NOT_CALIBRATED','INSUFFICIENT_SAMPLE')),
  lookahead_violations int not null default 0,
  artifact_path        text,
  notes                text,
  constraint model_backtests_chronology check (train_to < test_from and test_from <= test_to and (train_from is null or train_from <= train_to)),
  constraint model_backtests_no_lookahead check (lookahead_violations = 0)
);
comment on table public.model_backtests is
  'Backtest and calibration results by sport, market and model version. The training window must end before the test window, and a run with any look-ahead violation is refused.';
create index if not exists model_backtests_lookup_idx on public.model_backtests (sport, market, model_version, test_to desc);
alter table public.model_backtests enable row level security;
drop policy if exists model_backtests_read on public.model_backtests;
create policy model_backtests_read on public.model_backtests for select to authenticated using (true);
grant select on public.model_backtests to authenticated;
do $anon$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on public.model_backtests from anon; end if;
end $anon$;

-- ---------------------------------------------------------------------------
-- 5. WRITE ONCE, NO READER DELETES, ONE RETENTION DOOR
-- ---------------------------------------------------------------------------
create or replace function public.quant_desk_immutable()
returns trigger language plpgsql as $$
begin
  raise exception '% is write-once: row % cannot be updated', tg_table_name, old.id using errcode = 'restrict_violation';
end $$;
create or replace function public.quant_desk_no_delete()
returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('edgedesk.quant_prune', true), '') = 'on' then return old; end if;
  raise exception '% rows are not deleted (row %); retention runs through quant_desk_prune()', tg_table_name, old.id using errcode = 'restrict_violation';
end $$;
do $trg$
declare t text;
begin
  foreach t in array array['opportunity_audits','fair_price_estimates'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_immutable_trg', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.quant_desk_immutable()', t || '_immutable_trg', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_delete_trg', t);
    execute format('create trigger %I before delete on public.%I for each row execute function public.quant_desk_no_delete()', t || '_no_delete_trg', t);
  end loop;
end $trg$;

/* Retention: rows older than p_days (default 400, at least 90) are removed from the two
   ledgers. Service role only; returns what it removed. */
create or replace function public.quant_desk_prune(p_days int default 400)
returns table (table_name text, removed bigint)
language plpgsql security definer set search_path = public as $$
declare d int := greatest(90, coalesce(p_days, 400)); n bigint;
begin
  perform set_config('edgedesk.quant_prune', 'on', true);
  delete from public.opportunity_audits where created_at < now() - make_interval(days => d);
  get diagnostics n = row_count; table_name := 'opportunity_audits'; removed := n; return next;
  delete from public.fair_price_estimates where created_at < now() - make_interval(days => d);
  get diagnostics n = row_count; table_name := 'fair_price_estimates'; removed := n; return next;
  perform set_config('edgedesk.quant_prune', 'off', true);
end $$;
revoke all on function public.quant_desk_prune(int) from public;
do $grant$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public.quant_desk_prune(int) to service_role; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.quant_desk_prune(int) from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.quant_desk_prune(int) from anon; end if;
end $grant$;

-- ---------------------------------------------------------------------------
-- 6. ROW LEVEL SECURITY ON THE LEDGERS
-- ---------------------------------------------------------------------------
alter table public.opportunity_audits enable row level security;
drop policy if exists opportunity_audits_insert_own on public.opportunity_audits;
create policy opportunity_audits_insert_own on public.opportunity_audits for insert to authenticated with check (user_id = auth.uid());
drop policy if exists opportunity_audits_select_own on public.opportunity_audits;
create policy opportunity_audits_select_own on public.opportunity_audits for select to authenticated using (user_id = auth.uid());
grant select, insert on public.opportunity_audits to authenticated;
grant usage, select on sequence public.opportunity_audits_id_seq to authenticated;

alter table public.fair_price_estimates enable row level security;
drop policy if exists fair_price_estimates_insert_own on public.fair_price_estimates;
create policy fair_price_estimates_insert_own on public.fair_price_estimates for insert to authenticated with check (user_id = auth.uid());
drop policy if exists fair_price_estimates_select_own on public.fair_price_estimates;
create policy fair_price_estimates_select_own on public.fair_price_estimates for select to authenticated using (user_id = auth.uid());
grant select, insert on public.fair_price_estimates to authenticated;
grant usage, select on sequence public.fair_price_estimates_id_seq to authenticated;
do $anon$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.opportunity_audits from anon;
    revoke all on public.fair_price_estimates from anon;
  end if;
end $anon$;

-- ---------------------------------------------------------------------------
-- 7. THE GRADE — audited candidates beside the close of the signal they priced
--    (security_invoker: the reader's own rows only; signals read through
--    to_jsonb so an older signals table still builds the view)
-- ---------------------------------------------------------------------------
do $view$ begin
  if to_regclass('public.signals') is not null then
    execute $v$
      create or replace view public.opportunity_audit_grades with (security_invoker = true) as
      select a.audit_id, a.user_id, a.audited_at, a.sport, a.game_id, a.market, a.selection, a.line, a.book,
             a.odds_american, a.fair_probability, a.status, a.classification, a.independent_ev, a.sig_key,
             (to_jsonb(s) ->> 'closing_sharp_fair')::numeric as closing_fair,
             (to_jsonb(s) ->> 'clv')::numeric as clv,
             to_jsonb(s) ->> 'result' as result,
             (to_jsonb(s) ->> 'graded_at')::timestamptz as graded_at
      from public.opportunity_audits a
      left join public.signals s on s.sig_key = a.sig_key
    $v$;
    execute 'grant select on public.opportunity_audit_grades to authenticated';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on public.opportunity_audit_grades from anon'; end if;
  end if;
end $view$;

notify pgrst, 'reload schema';

-- THE REPORT.
select 'market_execution_costs table' as piece, case when to_regclass('public.market_execution_costs') is not null then 'ok' else 'CHECK THIS' end as state
union all select 'opportunity_audits table', case when to_regclass('public.opportunity_audits') is not null then 'ok' else 'CHECK THIS' end
union all select 'fair_price_estimates table', case when to_regclass('public.fair_price_estimates') is not null then 'ok' else 'CHECK THIS' end
union all select 'model_backtests table', case when to_regclass('public.model_backtests') is not null then 'ok' else 'CHECK THIS' end
union all select 'write-once triggers', case when (select count(*) from pg_trigger where tgname in ('opportunity_audits_immutable_trg','fair_price_estimates_immutable_trg')) = 2 then 'ok' else 'CHECK THIS' end
union all select 'no-delete triggers', case when (select count(*) from pg_trigger where tgname in ('opportunity_audits_no_delete_trg','fair_price_estimates_no_delete_trg')) = 2 then 'ok' else 'CHECK THIS' end
union all select 'row level security', case when (select count(*) from pg_class where oid in ('public.market_execution_costs'::regclass, 'public.opportunity_audits'::regclass, 'public.fair_price_estimates'::regclass, 'public.model_backtests'::regclass) and relrowsecurity) = 4 then 'ok' else 'CHECK THIS' end
union all select 'retention function', case when to_regprocedure('public.quant_desk_prune(int)') is not null then 'ok' else 'CHECK THIS' end
union all select 'audit grades view (needs public.signals)', case when to_regclass('public.opportunity_audit_grades') is not null then 'ok' when to_regclass('public.signals') is null then 'ok (signals absent: view skipped)' else 'CHECK THIS' end;
