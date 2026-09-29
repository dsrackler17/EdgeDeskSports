-- =============================================================================
-- player_props — EdgeDesk Player Props: identity, usage, availability, the
-- market, the model, the frozen record. docs/player-props/SCHEMA.md
--
-- WHAT IT HOLDS
--   IDENTITY      player_registry (durable EdgeDesk ids, minted once from the
--                 anchor provider id: NFL GSIS, CFB ESPN athlete),
--                 player_identity_map (every provider id and every sportsbook
--                 name a player has been quoted under), player_team_memberships
--   USAGE         player_game_logs (box score), player_usage_history (snaps,
--                 routes-estimate, targets, carries, red-zone and third-down
--                 usage per game) + the views player_snap_history,
--                 player_route_history, player_target_history,
--                 player_carry_history, player_red_zone_usage,
--                 player_game_participation
--   AVAILABILITY  player_depth_chart (timestamped snapshots), player_injuries
--                 (reports with their publish time), player_availability (the
--                 pregame status and play-through probability a projection used)
--   MARKET        player_prop_quotes (every captured tick, append-only),
--                 player_prop_markets (the current quote per book and line),
--                 player_prop_consensus (per capture), player_prop_closing_lines
--   MODEL         player_prop_model_versions, player_prop_projections,
--                 player_prop_distributions, player_prop_correlations,
--                 player_prop_calibration
--   RECORD        player_prop_snapshots, player_prop_decisions (the frozen
--                 pregame predictions), player_prop_grades
--
-- THE RULES, ENFORCED BY THE SERVER
--   1. Player ids are EdgeDesk ids (edp_…), never names.
--   2. Every quote, report and snapshot carries its own timestamp.
--   3. Append-only where history matters: quotes, projections,
--      distributions, snapshots, decisions, grades and closing lines refuse
--      UPDATE and DELETE (triggers), for every role.
--   4. No look-ahead: a decision or snapshot must be frozen before kickoff;
--      a grade must come after it.
--   5. Model output is public (it is committed to the public repository
--      anyway); captured prices and the current market are readable by a
--      signed-in reader; frozen decisions become public after kickoff.
--   6. Writes come from the pipeline under the service role.
--
-- CONVENTION (supabase/README.md): idempotent, additive, no psql
-- meta-commands, ends in a report. Safe to run again.
-- =============================================================================

-- ---------------------------------------------------------------- the guard
create or replace function public.player_props_append_only() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only: rows are never updated or deleted (a correction is a new row)', tg_table_name
    using errcode = 'restrict_violation';
end $$;

create or replace function public.player_props_pregame() returns trigger language plpgsql as $$
begin
  if new.kickoff is not null and new.frozen_at >= new.kickoff then
    raise exception '% refuses a row frozen at or after kickoff (% >= %)', tg_table_name, new.frozen_at, new.kickoff
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- ================================================================ IDENTITY
create table if not exists public.player_registry (
  player_id      text primary key check (player_id ~ '^edp_[0-9a-f]{12}$'),
  league         text not null check (league in ('NFL','CFB')),
  anchor_system  text not null check (anchor_system in ('gsis','espn')),
  anchor_id      text not null,
  full_name      text not null,
  slug           text not null,
  position       text,
  current_team   text,
  status         text,
  headshot_url   text,
  linked_player  text,
  first_seen     date,
  last_seen      date,
  updated_at     timestamptz not null default now(),
  unique (league, anchor_system, anchor_id),
  unique (league, slug)
);

create table if not exists public.player_identity_map (
  id            bigint generated always as identity primary key,
  player_id     text not null references public.player_registry(player_id),
  system        text not null,
  external_id   text not null,
  kind          text not null default 'provider_id' check (kind in ('provider_id','book_name','former_name','override')),
  book          text,
  observed_at   timestamptz not null default now(),
  unique (system, external_id, kind)
);
create index if not exists player_identity_map_player_idx on public.player_identity_map (player_id);

create table if not exists public.player_team_memberships (
  player_id   text not null references public.player_registry(player_id),
  league      text not null,
  team        text not null,
  first_seen  date not null,
  last_seen   date,
  primary key (player_id, team, first_seen)
);

-- =================================================================== USAGE
create table if not exists public.player_game_logs (
  league text not null, season int not null, week int, game_id text not null, kickoff timestamptz,
  player_id text not null references public.player_registry(player_id), team text not null, opponent text,
  position text, pass_att int, pass_cmp int, pass_yds int, pass_td int, pass_int int, sacks int,
  rush_att int, rush_yds int, rush_td int, targets int, receptions int, rec_yds int, rec_td int,
  long_rec int, long_rush int, long_cmp int, source text not null, loaded_at timestamptz not null default now(),
  primary key (league, game_id, player_id)
);
create index if not exists player_game_logs_player_idx on public.player_game_logs (player_id, kickoff desc);

create table if not exists public.player_usage_history (
  league text not null, game_id text not null, player_id text not null references public.player_registry(player_id),
  kickoff timestamptz, team text not null,
  snaps int, snap_share numeric, routes_est numeric, route_basis text,
  targets int, team_targets int, target_share numeric, air_yards numeric,
  carries int, team_designed_runs int, carry_share numeric,
  rz_targets int, rz_carries int, goal_line_carries int, third_down_targets int, neutral_targets int,
  source text not null, loaded_at timestamptz not null default now(),
  primary key (league, game_id, player_id)
);
create or replace view public.player_snap_history as select league, game_id, player_id, kickoff, team, snaps, snap_share from public.player_usage_history;
create or replace view public.player_route_history as select league, game_id, player_id, kickoff, team, routes_est, route_basis from public.player_usage_history;
create or replace view public.player_target_history as select league, game_id, player_id, kickoff, team, targets, team_targets, target_share, air_yards from public.player_usage_history;
create or replace view public.player_carry_history as select league, game_id, player_id, kickoff, team, carries, team_designed_runs, carry_share from public.player_usage_history;
create or replace view public.player_red_zone_usage as select league, game_id, player_id, kickoff, team, rz_targets, rz_carries, goal_line_carries from public.player_usage_history;
create or replace view public.player_game_participation as
  select league, game_id, player_id, kickoff, team, (coalesce(snaps,0) > 0 or coalesce(targets,0) + coalesce(carries,0) > 0) as participated, snaps, snap_share
  from public.player_usage_history;

-- ============================================================ AVAILABILITY
create table if not exists public.player_depth_chart (
  league text not null, team text not null, snapshot_at timestamptz not null,
  position text not null, rank int not null, player_id text references public.player_registry(player_id),
  source text not null, loaded_at timestamptz not null default now(),
  primary key (league, team, snapshot_at, position, rank)
);
create table if not exists public.player_injuries (
  id bigint generated always as identity primary key,
  league text not null, season int not null, week int, game_id text, team text not null,
  player_id text references public.player_registry(player_id), player_name text not null,
  report_status text, practice_status text, injury text, published_at timestamptz, retrieved_at timestamptz not null default now(),
  source text not null, source_url text,
  unique (league, season, week, team, player_name, report_status, published_at)
);
create table if not exists public.player_availability (
  league text not null, game_id text not null, player_id text not null references public.player_registry(player_id),
  as_of timestamptz not null, status text not null check (status in ('ACTIVE','QUESTIONABLE','DOUBTFUL','OUT','UNRESOLVED','UNKNOWN','PROBABLE')),
  p_active numeric check (p_active between 0 and 1), basis text,
  primary key (league, game_id, player_id, as_of)
);

-- ================================================================== MARKET
create table if not exists public.player_prop_quotes (
  quote_id        text primary key,
  league          text not null,
  game_id         text not null,
  kickoff         timestamptz,
  player_id       text references public.player_registry(player_id),
  book_player_name text not null,
  mapping_method  text,
  team            text, opponent text, home_away text check (home_away in ('home','away') or home_away is null),
  prop_type       text not null,
  market_key      text not null,
  is_alternate    boolean not null default false,
  book            text not null,
  line            numeric,
  over_price      numeric check (over_price is null or abs(over_price) >= 100),
  under_price     numeric check (under_price is null or abs(under_price) >= 100),
  book_updated_at timestamptz,
  captured_at     timestamptz not null,
  provider        text not null default 'the-odds-api',
  market_status   text not null default 'open',
  inserted_at     timestamptz not null default now()
);
create index if not exists player_prop_quotes_prop_idx on public.player_prop_quotes (game_id, player_id, prop_type, captured_at desc);
create index if not exists player_prop_quotes_time_idx on public.player_prop_quotes (captured_at desc);

create table if not exists public.player_prop_markets (
  market_key_id   text primary key,
  quote_id        text not null,
  league          text not null, game_id text not null, kickoff timestamptz,
  player_id       text, book_player_name text, prop_type text not null, is_alternate boolean not null default false,
  book            text not null, line numeric, over_price numeric, under_price numeric,
  captured_at     timestamptz not null, market_status text not null default 'open', updated_at timestamptz not null default now()
);
create index if not exists player_prop_markets_prop_idx on public.player_prop_markets (game_id, player_id, prop_type);

create table if not exists public.player_prop_consensus (
  id bigint generated always as identity primary key,
  league text not null, game_id text not null, player_id text, prop_type text not null, captured_at timestamptz not null,
  consensus_line numeric, median_line numeric, books int, novig_over numeric, hold_median numeric, dispersion_pp numeric,
  best_over_book text, best_over_price numeric, best_under_book text, best_under_price numeric,
  unique (game_id, player_id, prop_type, captured_at)
);

create table if not exists public.player_prop_closing_lines (
  league text not null, game_id text not null, player_id text not null, prop_type text not null, kickoff timestamptz not null,
  close_line numeric, close_over numeric, close_under numeric, close_novig_over numeric, closed_at timestamptz not null,
  basis text not null default 'last pre-kickoff capture', open_line numeric, open_at timestamptz,
  primary key (league, game_id, player_id, prop_type),
  check (closed_at <= kickoff)
);

-- =================================================================== MODEL
create table if not exists public.player_prop_model_versions (
  model_version   text primary key,
  league          text not null,
  released_at     timestamptz not null,
  feature_version text,
  calibration_version text,
  changes         text not null,
  supersedes      text
);
insert into public.player_prop_model_versions (model_version, league, released_at, feature_version, calibration_version, changes)
values ('NFL_PLAYER_PROPS_V1.0', 'NFL', '2026-09-29T00:00:00Z', 'props_nfl_fv1', 'props_nfl_calibration_v1', 'First release: opportunity → efficiency → Monte Carlo, EdgeDesk game-model environment, empirical-Bayes shrinkage, availability redistribution, per-prop calibration fitted on 2025 weeks 3-12 and judged on a later holdout.'),
       ('CFB_PLAYER_PROPS_V1.0', 'CFB', '2026-09-29T00:00:00Z', 'props_cfb_fv1', null, 'First release: the NFL architecture on cfbfastR per-play data; no snaps, routes or provider depth chart; stricter reliability and thresholds.')
on conflict (model_version) do nothing;

create table if not exists public.player_prop_projections (
  projection_id   text primary key,
  league          text not null,
  model_version   text not null references public.player_prop_model_versions(model_version),
  game_id         text not null,
  kickoff         timestamptz,
  player_id       text not null references public.player_registry(player_id),
  prop_type       text not null,
  as_of           timestamptz not null,
  inputs_hash     text not null,
  status          text not null,
  mean numeric, median numeric, sd numeric, p10 numeric, p25 numeric, p75 numeric, p90 numeric, fair_line numeric,
  reliability     int,
  stage           text,
  opportunity     jsonb,
  drivers         jsonb,
  risks           jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists player_prop_projections_game_idx on public.player_prop_projections (game_id, player_id, prop_type, as_of desc);

create table if not exists public.player_prop_distributions (
  projection_id text primary key references public.player_prop_projections(projection_id),
  lo int not null, n int not null, pmf int[] not null, sims int,
  created_at timestamptz not null default now()
);

create table if not exists public.player_prop_correlations (
  league text not null, game_id text not null, model_version text not null, projection_a text not null, projection_b text not null,
  rho numeric not null check (rho between -1 and 1), same_team boolean, created_at timestamptz not null default now(),
  primary key (game_id, projection_a, projection_b)
);

create table if not exists public.player_prop_calibration (
  league text not null, model_version text not null, prop_type text not null, horizon text not null default 'pregame',
  measured_at timestamptz not null, n int not null, brier numeric, log_loss numeric, slope numeric, intercept numeric,
  bins jsonb, lambda numeric, kappa numeric, stage text, source text not null,
  primary key (league, model_version, prop_type, horizon, measured_at)
);

-- ================================================================== RECORD
create table if not exists public.player_prop_snapshots (
  snapshot_id text primary key, league text not null, game_id text not null, kickoff timestamptz not null,
  player_id text not null, prop_type text not null, projection_id text, frozen_at timestamptz not null,
  consensus_line numeric, novig_over numeric, books int, fair_line numeric, mean numeric, median numeric, model_version text not null,
  payload jsonb
);
create table if not exists public.player_prop_decisions (
  prediction_id   text primary key check (prediction_id ~ '^ppd_[0-9a-f]{16}$'),
  kind            text not null check (kind in ('FIRST','DECISION_CHANGE','PREGAME_FINAL')),
  league          text not null, season int, week int, game_id text not null, kickoff timestamptz not null,
  player_id       text not null, player_name text, team text, opponent text, position text,
  prop_type       text not null, side text not null check (side in ('over','under','yes','no')),
  line            numeric, american numeric not null check (abs(american) >= 100), book text not null, is_alternate boolean not null default false,
  quote_captured_at timestamptz,
  model_prob numeric, model_cover numeric, market_prob numeric, fair_american numeric, fair_line numeric,
  projection_mean numeric, projection_median numeric, edge_pp numeric, ev numeric, decision_prob numeric, decision_ev numeric,
  decision text not null check (decision in ('BET','LEAN','WATCH','PASS')), reason_code text,
  units numeric not null default 0 check (units >= 0 and units <= 1), reliability int, confidence_tier text, stage text,
  model_version text not null, projection_id text, frozen_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (decision <> 'BET' or units > 0)
);
create index if not exists player_prop_decisions_game_idx on public.player_prop_decisions (game_id, player_id, prop_type, frozen_at);

create table if not exists public.player_prop_grades (
  prediction_id text primary key references public.player_prop_decisions(prediction_id),
  result text not null check (result in ('WIN','LOSS','PUSH','VOID')), void_reason text,
  actual numeric, profit_units numeric, flat_profit numeric, close_line numeric, close_over numeric, close_under numeric,
  clv_price numeric, clv_line numeric, graded_at timestamptz not null, kickoff timestamptz not null,
  check (graded_at > kickoff)
);

-- ================================================ append-only and pregame
do $$
declare t text;
begin
  foreach t in array array['player_prop_quotes','player_prop_projections','player_prop_distributions','player_prop_snapshots',
                           'player_prop_decisions','player_prop_grades','player_prop_closing_lines','player_prop_consensus'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_no_update', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.player_props_append_only()', t || '_no_update', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_delete', t);
    execute format('create trigger %I before delete on public.%I for each row execute function public.player_props_append_only()', t || '_no_delete', t);
  end loop;
end $$;
drop trigger if exists player_prop_decisions_pregame on public.player_prop_decisions;
create trigger player_prop_decisions_pregame before insert on public.player_prop_decisions for each row execute function public.player_props_pregame();
drop trigger if exists player_prop_snapshots_pregame on public.player_prop_snapshots;
create trigger player_prop_snapshots_pregame before insert on public.player_prop_snapshots for each row execute function public.player_props_pregame();

-- ===================================================================== RLS
do $$
declare t text;
begin
  foreach t in array array['player_registry','player_identity_map','player_team_memberships','player_game_logs','player_usage_history',
                           'player_depth_chart','player_injuries','player_availability','player_prop_quotes','player_prop_markets',
                           'player_prop_consensus','player_prop_closing_lines','player_prop_model_versions','player_prop_projections',
                           'player_prop_distributions','player_prop_correlations','player_prop_calibration','player_prop_snapshots',
                           'player_prop_decisions','player_prop_grades'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- model output, identity, usage, availability, closes and grades: public
do $$
declare t text;
begin
  foreach t in array array['player_registry','player_identity_map','player_team_memberships','player_game_logs','player_usage_history',
                           'player_depth_chart','player_injuries','player_availability','player_prop_closing_lines','player_prop_model_versions',
                           'player_prop_projections','player_prop_distributions','player_prop_correlations','player_prop_calibration','player_prop_grades'] loop
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to anon, authenticated using (true)', t || '_read', t);
    execute format('grant select on public.%I to anon, authenticated', t);
  end loop;
end $$;
-- captured prices and the live market: signed-in readers
do $$
declare t text;
begin
  foreach t in array array['player_prop_quotes','player_prop_markets','player_prop_consensus','player_prop_snapshots'] loop
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_read', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;
-- frozen decisions: signed-in readers always; everyone once the game has kicked off
drop policy if exists player_prop_decisions_read_auth on public.player_prop_decisions;
create policy player_prop_decisions_read_auth on public.player_prop_decisions for select to authenticated using (true);
drop policy if exists player_prop_decisions_read_public on public.player_prop_decisions;
create policy player_prop_decisions_read_public on public.player_prop_decisions for select to anon using (kickoff <= now());
grant select on public.player_prop_decisions to anon, authenticated;
grant select on public.player_snap_history, public.player_route_history, public.player_target_history, public.player_carry_history,
  public.player_red_zone_usage, public.player_game_participation to anon, authenticated;
-- the append-only tables refuse change even to the service role
revoke update, delete on public.player_prop_quotes, public.player_prop_projections, public.player_prop_distributions, public.player_prop_snapshots,
  public.player_prop_decisions, public.player_prop_grades, public.player_prop_closing_lines, public.player_prop_consensus from service_role;

-- ============================================================ the scorecard
create or replace view public.player_prop_record as
select d.prediction_id, d.league, d.season, d.week, d.game_id, d.kickoff, d.player_id, d.player_name, d.position, d.prop_type, d.side, d.line, d.american, d.book,
       d.model_cover, d.market_prob, d.fair_american, d.edge_pp, d.ev, d.decision, d.units, d.reliability, d.confidence_tier, d.stage, d.model_version, d.kind,
       g.result, g.actual, g.profit_units, g.flat_profit, g.clv_price, g.clv_line, g.graded_at
from public.player_prop_decisions d
left join public.player_prop_grades g on g.prediction_id = d.prediction_id;
grant select on public.player_prop_record to anon, authenticated;

notify pgrst, 'reload schema';

-- THE REPORT.
select 'player_registry' as piece, case when to_regclass('public.player_registry') is not null then 'ok' else 'CHECK THIS' end as state
union all select 'player_identity_map', case when to_regclass('public.player_identity_map') is not null then 'ok' else 'CHECK THIS' end
union all select 'player_usage_history + views', case when to_regclass('public.player_usage_history') is not null and to_regclass('public.player_target_history') is not null and to_regclass('public.player_red_zone_usage') is not null then 'ok' else 'CHECK THIS' end
union all select 'player_injuries / availability / depth', case when to_regclass('public.player_injuries') is not null and to_regclass('public.player_availability') is not null and to_regclass('public.player_depth_chart') is not null then 'ok' else 'CHECK THIS' end
union all select 'player_prop_quotes (append-only)', case when exists (select 1 from pg_trigger where tgname = 'player_prop_quotes_no_update') then 'ok' else 'CHECK THIS' end
union all select 'player_prop_markets', case when to_regclass('public.player_prop_markets') is not null then 'ok' else 'CHECK THIS' end
union all select 'player_prop_projections (append-only)', case when exists (select 1 from pg_trigger where tgname = 'player_prop_projections_no_update') then 'ok' else 'CHECK THIS' end
union all select 'player_prop_decisions (pregame, append-only)', case when exists (select 1 from pg_trigger where tgname = 'player_prop_decisions_pregame') and exists (select 1 from pg_trigger where tgname = 'player_prop_decisions_no_delete') then 'ok' else 'CHECK THIS' end
union all select 'player_prop_grades (append-only)', case when exists (select 1 from pg_trigger where tgname = 'player_prop_grades_no_update') then 'ok' else 'CHECK THIS' end
union all select 'model versions seeded', case when (select count(*) from public.player_prop_model_versions) >= 2 then 'ok' else 'CHECK THIS' end
union all select 'player_prop_record view', case when to_regclass('public.player_prop_record') is not null then 'ok' else 'CHECK THIS' end;
