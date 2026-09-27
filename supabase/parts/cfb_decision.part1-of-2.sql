-- cfb_decision -- part 1 of 2.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- =============================================================================
-- cfb_decision — the Postgres half of the CFB wagering calibration and
-- decision science system (docs/cfb-decision/DESIGN.md).
--
-- WHAT IT IS
--   Every wager decision the engine makes (football/cfb_decision/decision.js),
--   per game x sportsbook quote x snapshot x engine version, with its
--   probabilities, prices, thresholds, confidences and reasons; the eligibility
--   checks behind it; its graded result (process and outcome kept apart); the
--   calibration artifacts, EV curves, decision policies, bankroll policies and
--   decision-model versions it ran under; portfolio exposure; experiments
--   (walk-forward tournaments, shadow comparisons); and people's own wagers,
--   stored apart and never official. Mirrored insert-only by
--   football/cfb_decision/sync_supabase.js.
--
-- THE RULES, ENFORCED BY THE SERVER
--   1. Append-only (update / delete / truncate refused, service role included).
--      A decision is never rewritten after results; a policy change is a new
--      policy version.
--   2. A decision is made before kickoff and names the policy, calibration
--      artifact and football model version it ran under.
--   3. A BET has a captured price (never an assumed one), a positive stake
--      within the bankroll policy's hard cap, and a probability edge; a PASS or
--      NO_BET has at least one reason code; probabilities are probabilities.
--   4. Manual wagers live in cfb_manual_decisions and can never be official.
--   5. No production policy, calibration or engine version without a person
--      and the evidence it was judged on.
--   6. Internal: authenticated reads, anon reads nothing.
--
-- DEPENDENCIES: none. CONVENTION (supabase/README.md): idempotent, additive,
-- pasted into the SQL editor, no psql meta-commands, ends in a report. Safe to
-- run again. Tested against a real PostgreSQL by football/cfb_decision/sql.test.js.
-- =============================================================================

-- ======================================================== versions first
create table if not exists public.cfb_decision_model_versions (
  version_row_id     text primary key,
  decision_version   text not null,
  engine_version     text not null,
  policy_version     text,
  artifact_version   text,
  base_model_version text not null,
  status             text not null,
  decided_at         timestamptz not null,
  decided_by         text,
  evidence           text,
  payload            jsonb not null,
  recorded_at        timestamptz not null default now(),
  constraint cfb_dmv_status check (status in ('BASELINE','RESEARCH','SHADOW','PRODUCTION','RETIRED','REJECTED')),
  constraint cfb_dmv_production check (status <> 'PRODUCTION' or (decided_by is not null and evidence is not null))
);

create table if not exists public.cfb_probability_calibration (
  calibration_row_id text primary key,
  artifact_version   text not null,
  base_model_version text not null,
  method             text not null,
  fit_seasons        int[] not null,
  status             text not null,
  artifact_sha256    text not null,
  brier              numeric,
  ece                numeric,
  n                  int,
  payload            jsonb not null,
  recorded_at        timestamptz not null default now(),
  constraint cfb_pc_method check (method in ('identity','platt','beta','isotonic','logit_pwl','conditional')),
  constraint cfb_pc_status check (status in ('RESEARCH','VALIDATED','PRODUCTION','RETIRED','REJECTED')),
  constraint cfb_pc_metrics check ((brier is null or brier between 0 and 1) and (ece is null or ece between 0 and 1))
);
create unique index if not exists cfb_probability_calibration_key on public.cfb_probability_calibration (artifact_version, method, status);

create table if not exists public.cfb_ev_calibration (
  ev_calibration_id  text primary key,
  artifact_version   text not null,
  bucket_lo          numeric,
  bucket_hi          numeric,
  n                  int not null,
  predicted_ev       numeric,
  realized_roi       numeric,
  realized_roi_lo95  numeric,
  realized_roi_hi95  numeric,
  mean_clv_pts       numeric,
  price_source       text not null,
  payload            jsonb not null,
  recorded_at        timestamptz not null default now(),
  -- the historical archive has no prices: say which price every number assumed
  constraint cfb_evc_price_source check (price_source in ('CAPTURED','ASSUMED_-110')),
  constraint cfb_evc_ci check (realized_roi_lo95 is null or realized_roi_hi95 is null or realized_roi_lo95 <= realized_roi_hi95)
);

create table if not exists public.cfb_decision_policies (
  policy_row_id      text primary key,
  policy_version     text not null,
  status             text not null,
  bet_enabled        boolean not null,
  min_probability_edge numeric not null,
  min_ev             numeric not null,
  max_price          int,
  stale_minutes      int not null,
  decided_at         timestamptz not null,
  decided_by         text,
  evidence           text,
  payload            jsonb not null,
  recorded_at        timestamptz not null default now(),
  constraint cfb_dp_status check (status in ('UNVALIDATED_DEFAULT','RESEARCH','SHADOW','PRODUCTION','RETIRED','REJECTED')),
  constraint cfb_dp_thresholds check (min_probability_edge >= 0 and min_ev >= 0 and stale_minutes > 0),
  constraint cfb_dp_production check (status <> 'PRODUCTION' or (decided_by is not null and evidence is not null)),
  -- betting can be switched on only by a policy that went through its gate
  constraint cfb_dp_bet_enabled check (not bet_enabled or status in ('SHADOW','PRODUCTION'))
);
create unique index if not exists cfb_decision_policies_key on public.cfb_decision_policies (policy_version, status);

create table if not exists public.cfb_bankroll_policy (
  bankroll_row_id    text primary key,
  bankroll_version   text not null,
  method             text not null,
  kelly_fraction     numeric,
  max_stake_u        numeric not null,
  max_game_u         numeric not null,
  max_slate_u        numeric not null,
  status             text not null,
  decided_at         timestamptz not null,
  decided_by         text,
  payload            jsonb not null,
  recorded_at        timestamptz not null default now(),
  constraint cfb_bp_method check (method in ('flat','fractional_kelly')),
  -- never full Kelly; never an uncapped stake
  constraint cfb_bp_kelly check (kelly_fraction is null or (kelly_fraction > 0 and kelly_fraction <= 0.25)),
  constraint cfb_bp_caps check (max_stake_u > 0 and max_stake_u <= 2 and max_game_u >= max_stake_u and max_slate_u >= max_game_u),
  constraint cfb_bp_status check (status in ('RESEARCH','SHADOW','PRODUCTION','RETIRED'))
);

-- =============================================================== decisions
create table if not exists public.cfb_decision_snapshots (
  decision_id        text primary key,
  game_id            text not null,
  season             int not null,
  week               int,
  book               text,
  quote_id           text,
  observed_at        timestamptz,
  decided_at         timestamptz not null,
  kickoff_ts         timestamptz not null,
  engine_version     text not null,
  engine_role        text not null,
  policy_version     text,
  artifact_version   text,
  model_version      text not null,
  status             text not null,
  timing             text not null,
  side               text,
  line_for_side      numeric,
  price              int,
  pure_cover_probability numeric,
  decision_cover_probability numeric,
  break_even_probability numeric,
  probability_edge   numeric,
  theoretical_ev     numeric,
  empirical_ev       numeric,
  p_positive_clv     numeric,
  expected_clv_pts   numeric,
  football_confidence numeric,
  market_confidence  numeric,
  bet_confidence     numeric,
  bettable_to_line   numeric,
  bettable_to_price  int,
  stake_u            numeric,
  reason_codes       text[] not null,
  official           boolean not null default true,
  payload            jsonb not null,
  recorded_at        timestamptz not null default now(),
  constraint cfb_ds_status check (status in ('BET','LEAN','RESEARCH','PASS','NO_BET')),
  constraint cfb_ds_timing check (timing in ('BET_NOW','WAIT','NONE')),
  constraint cfb_ds_role check (engine_role in ('CURRENT','CHALLENGER','BASELINE')),
  constraint cfb_ds_side check (side is null or side in ('HOME','AWAY')),
  constraint cfb_ds_pregame check (decided_at < kickoff_ts and (observed_at is null or observed_at <= decided_at)),
  constraint cfb_ds_probs check ((pure_cover_probability is null or (pure_cover_probability > 0 and pure_cover_probability < 1))
    and (decision_cover_probability is null or (decision_cover_probability > 0 and decision_cover_probability < 1))
    and (break_even_probability is null or (break_even_probability > 0 and break_even_probability < 1))
    and (p_positive_clv is null or (p_positive_clv >= 0 and p_positive_clv <= 1))),
  constraint cfb_ds_price check (price is null or price <= -100 or price >= 100),
  -- a BET: a captured price, a positive capped stake, a real edge, its versions named
  constraint cfb_ds_bet check (status <> 'BET' or (price is not null and stake_u > 0 and stake_u <= 2
    and probability_edge > 0 and policy_version is not null and artifact_version is not null and side is not null)),
  constraint cfb_ds_reasons check (cardinality(reason_codes) >= 1),
  constraint cfb_ds_stake check (stake_u is null or stake_u >= 0),
  constraint cfb_ds_official check (official)
);
create unique index if not exists cfb_decision_snapshots_key
  on public.cfb_decision_snapshots (game_id, coalesce(book, ''), decided_at, engine_version, coalesce(policy_version, ''));
create index if not exists cfb_decision_snapshots_game on public.cfb_decision_snapshots (game_id, decided_at);

create table if not exists public.cfb_bet_eligibility (
  eligibility_id     text primary key,
  decision_id        text not null,
  check_name         text not null,
  ok                 boolean not null,
  value              numeric,
  threshold          numeric,
  payload            jsonb not null,
  recorded_at        timestamptz not null default now()
);
create unique index if not exists cfb_bet_eligibility_key on public.cfb_bet_eligibility (decision_id, check_name);

create table if not exists public.cfb_portfolio_exposure (
  exposure_id        text primary key,
  season             int not null,
  week               int,
  as_of              timestamptz not null,
  scope              text not null,
  scope_key          text not null,
  positions          int not null,
  stake_u            numeric not null,
  cap_u              numeric,
  scaled             boolean not null default false,
  bankroll_version   text,
  payload            jsonb not null,
  recorded_at        timestamptz not null default now(),
  constraint cfb_pe_scope check (scope in ('GAME','CLUSTER','SLATE')),
  constraint cfb_pe_cap check (cap_u is null or stake_u <= cap_u + 1e-9)
);

-- ================================================================ results
-- Process and outcome are graded separately: a good price that lost is a good
-- decision; a bad price that won is a bad one.
create table if not exists public.cfb_decision_results (
  result_id          text primary key,
  decision_id        text not null,
  graded_at          timestamptz not null,
  final_margin       numeric,
  ats_result         text,
  units              numeric,
  closing_line_for_side numeric,
  closing_price      int,
  clv_pts            numeric,
  positive_clv       boolean,
  process_grade      text,
  outcome_grade      text,
  payload            jsonb not null,
  recorded_at        timestamptz not null default now(),
  constraint cfb_dr_ats check (ats_result is null or ats_result in ('W','L','P','NO_ACTION')),
  constraint cfb_dr_process check (process_grade is null or process_grade in ('GOOD_PRICE','FAIR_PRICE','BAD_PRICE','NOT_GRADABLE')),
  constraint cfb_dr_outcome check (outcome_grade is null or outcome_grade in ('WIN','LOSS','PUSH','NO_ACTION'))
);
create unique index if not exists cfb_decision_results_key on public.cfb_decision_results (decision_id);

create table if not exists public.cfb_decision_experiments (
  experiment_id      text primary key,
  kind               text not null,
  name               text not null,
  train_seasons      int[],
  validate_seasons   int[],
  holdout_seasons    int[],
  holdout_scored     boolean not null default false,
  started_at         timestamptz not null,
  payload            jsonb not null,
  recorded_at        timestamptz not null default now(),
  constraint cfb_de_kind check (kind in ('WALK_FORWARD','HOLDOUT','SHADOW','ABLATION','THRESHOLD_SWEEP','CALIBRATION')),
  -- a holdout can be scored once: an experiment that scored it is final
  constraint cfb_de_holdout check (kind <> 'HOLDOUT' or holdout_scored)
);
create unique index if not exists cfb_decision_experiments_holdout_once
  on public.cfb_decision_experiments (name) where kind = 'HOLDOUT';

-- ============================================================= manual
create table if not exists public.cfb_manual_decisions (
  manual_id          text primary key,
  game_id            text not null,
  book               text,
  side               text,
  line               numeric,
  price              int,
  stake_u            numeric,
  decided_by         text not null,
  decided_at         timestamptz not null,
  model_status_at_the_time text,
  note               text,
  manual_decision    boolean not null default true,
  official           boolean not null default false,
  payload            jsonb not null,
  recorded_at        timestamptz not null default now(),
  constraint cfb_md_manual check (manual_decision and not official)
);

-- ===================================================== append-only + access
create or replace function public.cfb_decision_append_only()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $fn$
begin
  if tg_op = 'UPDATE' then
    raise exception '% is append-only: a decision is never rewritten (a change is a new version)', tg_table_name
      using errcode = 'restrict_violation';
  elsif tg_op = 'DELETE' then
    raise exception '% is append-only: rows are never deleted', tg_table_name
      using errcode = 'restrict_violation';
  else
    raise exception '% is append-only: it is never truncated', tg_table_name
      using errcode = 'restrict_violation';
  end if;
end $fn$;

do $blk$
declare
  t text;
begin
  foreach t in array array['cfb_decision_model_versions','cfb_probability_calibration','cfb_ev_calibration',
    'cfb_decision_policies','cfb_bankroll_policy','cfb_decision_snapshots','cfb_bet_eligibility',
    'cfb_portfolio_exposure','cfb_decision_results','cfb_decision_experiments','cfb_manual_decisions']
  loop
    execute format('drop trigger if exists %I on public.%I', t || '_no_update_trg', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.cfb_decision_append_only()', t || '_no_update_trg', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_delete_trg', t);
    execute format('create trigger %I before delete on public.%I for each row execute function public.cfb_decision_append_only()', t || '_no_delete_trg', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate_trg', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.cfb_decision_append_only()', t || '_no_truncate_trg', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_read', t);
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on table public.%I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke insert, update, delete, truncate, references, trigger on table public.%I from authenticated', t);
      execute format('grant select on table public.%I to authenticated', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke update, delete, truncate on table public.%I from service_role', t);
      execute format('grant select, insert on table public.%I to service_role', t);
    end if;
  end loop;
end $blk$;

-- ============================================================ Model Lab views
-- The decision panel: every number beside the status that produced it.
create or replace view public.cfb_decision_lab_view as
select d.decision_id, d.game_id, d.season, d.week, d.book, d.decided_at, d.engine_version, d.engine_role,
       d.status, d.timing, d.side, d.line_for_side, d.price,
       d.pure_cover_probability      as predicted_cover_probability,
       d.decision_cover_probability  as calibrated_decision_probability,
       d.break_even_probability, d.probability_edge,
       d.theoretical_ev, d.empirical_ev as empirically_adjusted_ev,
       d.p_positive_clv as clv_probability, d.expected_clv_pts,
       d.football_confidence, d.market_confidence, d.bet_confidence,
       d.bettable_to_line, d.bettable_to_price, d.stake_u as risk_exposure_u, d.reason_codes,
       r.ats_result, r.units, r.clv_pts, r.positive_clv, r.process_grade, r.outcome_grade
  from public.cfb_decision_snapshots d
  left join public.cfb_decision_results r on r.decision_id = d.decision_id;
