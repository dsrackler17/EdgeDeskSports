-- ============================================================================
-- EdgeDesk — the NHL warehouse (schema `nhl`).
--
-- The NHL brain (hockey/, docs/engine/NHL.md) computes everything from
-- committed files and the public mirror of the NHL's feeds. This schema puts
-- the same facts and outputs in Supabase so the desk, SQL and future services
-- can query them, with provenance on every row. It is written ONLY by
-- hockey/warehouse/sync.js (service role, via PostgREST), and only when the
-- repository variable NHL_WAREHOUSE is "on" — nothing writes here by default.
--
-- Idempotent and additive: create ... if not exists, create or replace.
-- Re-running changes no stored row. Ends with a report; every row must read ok.
--
-- WHAT IS PUBLIC. EdgeDesk's own outputs and their provenance (games,
-- periods, pregame predictions, validation summaries, reconciliation, the
-- source registry, model versions) are readable by anon and authenticated —
-- the same content hockey/slate.json already publishes. The per-player and
-- per-team statistics derived from NHL data (team_games, goalie_games,
-- skater_games, players) are service-role only until the owner's review of
-- the NHL's commercial-use terms (docs/engine/access-requests/nhl-commercial.md).
--
-- TIME. `known_at` is when the source first published a fact: never recorded
-- for history, so NULL (never backdated). `assumed_available_at` is the
-- explicit modelling assumption (scheduled start + 4 h); `pit` = 'RETRO'.
-- Pregame predictions are append-only: a trigger refuses UPDATE and DELETE,
-- and a check refuses a prediction recorded at or after the start.
--
-- After applying: add `nhl` to the exposed schemas (supabase/expose_schemas.sql
-- or Dashboard → API → Exposed schemas), then set the repository variable
-- NHL_WAREHOUSE=on.
-- ============================================================================
create schema if not exists nhl;
grant usage on schema nhl to anon, authenticated, service_role;

-- ── provenance ─────────────────────────────────────────────────────────────
create table if not exists nhl.sources (
  source_id      text primary key,
  name           text not null,
  url            text,
  status         text not null check (status in ('OPERATIONAL','STALE','INCOMPLETE','AWAITING_AUTHORISATION','AWAITING_PERMISSION','METHODOLOGY_ONLY','RESEARCH_COPY','NOT_AVAILABLE')),
  authorised_for text[] not null default '{}',
  terms          jsonb not null default '{}'::jsonb,
  cost           text,
  last_sync      timestamptz,
  contribution   jsonb,
  detail         jsonb not null default '{}'::jsonb,
  updated_at     timestamptz not null default now()
);

create table if not exists nhl.sync_state (
  dataset    text not null,
  part       text not null,
  sha256     text not null,
  rows       integer not null,
  synced_at  timestamptz not null default now(),
  primary key (dataset, part)
);

create table if not exists nhl.sync_runs (
  run_id      text primary key,
  started_at  timestamptz not null,
  finished_at timestamptz,
  status      text not null check (status in ('running','ok','partial','failed')),
  datasets    jsonb not null default '{}'::jsonb,
  detail      jsonb not null default '{}'::jsonb
);

-- ── facts ──────────────────────────────────────────────────────────────────
create table if not exists nhl.games (
  game_id              bigint primary key,
  season               integer not null,
  game_type            text not null check (game_type in ('R','P')),
  game_date            date not null,
  start_utc            timestamptz,
  home                 text not null,
  away                 text not null,
  final_home           integer,
  final_away           integer,
  reg_home             integer,
  reg_away             integer,
  decided              text check (decided in ('REG','OT','SO')),
  known_at             timestamptz,
  assumed_available_at timestamptz,
  pit                  text not null default 'RETRO',
  source               text not null,
  src_hash             text,
  synced_at            timestamptz not null default now()
);
create index if not exists nhl_games_date on nhl.games (game_date);

create table if not exists nhl.game_periods (
  game_id   bigint primary key references nhl.games (game_id) on delete cascade,
  h1 integer, a1 integer, h2 integer, a2 integer, h3 integer, a3 integer,
  hot integer, aot integer, h_en integer, a_en integer, h_late integer, a_late integer,
  check_note text,
  synced_at timestamptz not null default now()
);

create table if not exists nhl.team_games (
  game_id   bigint not null references nhl.games (game_id) on delete cascade,
  team      text not null,
  opp       text not null,
  home      boolean not null,
  gf integer, ga integer, gf_reg integer, ga_reg integer,
  toi_ev5 integer, toi_pp integer, toi_sh integer,
  ev5_xgf numeric, ev5_ff integer, ev5_cf integer, pp_xgf numeric, sh_xgf numeric,
  pim integer, g_start bigint,
  xg_model  text,
  synced_at timestamptz not null default now(),
  primary key (game_id, team)
);

create table if not exists nhl.goalie_games (
  game_id   bigint not null,
  goalie_id bigint not null,
  team      text not null,
  starter   boolean not null default false,
  toi_s integer, shots_against integer, saves integer, goals_against integer,
  source    text not null default 'boxscore',
  synced_at timestamptz not null default now(),
  primary key (game_id, goalie_id)
);

create table if not exists nhl.skater_games (
  game_id   bigint not null,
  player_id bigint not null,
  team      text not null,
  pos       text,
  toi_s integer, goals integer, assists integer, shots_on_goal integer, pp_goals integer,
  ixg numeric,
  source    text not null default 'boxscore+pbp',
  synced_at timestamptz not null default now(),
  primary key (game_id, player_id)
);

create table if not exists nhl.players (
  player_id bigint primary key,
  name      text,
  synced_at timestamptz not null default now()
);

-- ── outputs ────────────────────────────────────────────────────────────────
create table if not exists nhl.model_versions (
  model_id      text primary key,
  kind          text not null,
  train_seasons text,
  params_sha256 text,
  record        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create table if not exists nhl.predictions (
  id               text primary key,               -- the ledger's content hash
  game_id          bigint not null,
  model_id         text not null,
  recorded_at      timestamptz not null,
  start_utc        timestamptz not null,
  home             text not null,
  away             text not null,
  p_home           numeric not null check (p_home > 0 and p_home < 1),
  reg              jsonb,
  pl_home_minus_1_5 numeric,
  exp_total        numeric,
  over_5_5         numeric,
  over_6_5         numeric,
  goalie_certainty text,
  market           jsonb,
  synced_at        timestamptz not null default now(),
  constraint nhl_predictions_pregame check (recorded_at < start_utc)
);
create index if not exists nhl_predictions_game on nhl.predictions (game_id, recorded_at);

create or replace function nhl.forbid_change() returns trigger language plpgsql as $$
begin
  raise exception 'nhl.%: pregame records are append-only (% refused)', tg_table_name, tg_op;
end $$;
drop trigger if exists nhl_predictions_append_only on nhl.predictions;
create trigger nhl_predictions_append_only before update or delete on nhl.predictions
  for each row execute function nhl.forbid_change();

create table if not exists nhl.quotes (
  quote_id    text primary key,                    -- hash of book, market, side, line, price, capture time
  game_id     bigint not null,
  book        text not null,
  market      text not null check (market in ('h2h','spreads','totals')),
  side        text not null,
  line        numeric,
  american    integer not null,
  captured_at timestamptz not null,
  source      text not null default 'odds_gateway',
  settles     text,
  synced_at   timestamptz not null default now()
);
create index if not exists nhl_quotes_game on nhl.quotes (game_id, captured_at);

create table if not exists nhl.validation_runs (
  file         text primary key,
  schema_name  text,
  generated_at timestamptz,
  summary      jsonb not null default '{}'::jsonb,
  synced_at    timestamptz not null default now()
);

create table if not exists nhl.reconciliation (
  season    integer not null,
  quantity  text not null,
  rows      integer not null,
  agree     integer not null,
  rate      numeric,
  status    text,
  synced_at timestamptz not null default now(),
  primary key (season, quantity)
);

-- ── access ─────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['sources','sync_state','sync_runs','games','game_periods','team_games','goalie_games','skater_games','players','model_versions','predictions','quotes','validation_runs','reconciliation'] loop
    execute format('alter table nhl.%I enable row level security', t);
    execute format('grant select, insert, update, delete on nhl.%I to service_role', t);
  end loop;
  foreach t in array array['sources','games','game_periods','model_versions','predictions','validation_runs','reconciliation'] loop
    execute format('grant select on nhl.%I to anon, authenticated', t);
    execute format('drop policy if exists %I on nhl.%I', 'nhl_public_read_' || t, t);
    execute format('create policy %I on nhl.%I for select to anon, authenticated using (true)', 'nhl_public_read_' || t, t);
  end loop;
end $$;

-- ── report ─────────────────────────────────────────────────────────────────
select check_name, got, want, case when got = want then 'ok' else 'CHECK THIS' end as status from (
  select 'nhl tables' as check_name, (select count(*) from information_schema.tables where table_schema = 'nhl')::text as got, '14' as want
  union all
  select 'row level security on every nhl table', (select count(*) from pg_tables where schemaname = 'nhl' and rowsecurity)::text, '14'
  union all
  select 'predictions are append-only (trigger present)', (select count(*) from pg_trigger where tgname = 'nhl_predictions_append_only')::text, '1'
  union all
  select 'public read on the seven output tables', (select count(*) from pg_policies where schemaname = 'nhl' and policyname like 'nhl_public_read_%')::text, '7'
  union all
  select 'player statistics are not public', (select count(*) from information_schema.role_table_grants where table_schema = 'nhl' and table_name in ('team_games','goalie_games','skater_games','players') and grantee in ('anon','authenticated'))::text, '0'
) r;
