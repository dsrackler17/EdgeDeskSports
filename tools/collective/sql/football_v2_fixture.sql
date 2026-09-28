-- ===========================================================================
-- A PRODUCTION-SHAPED Collective + odds schema, FOR TESTING ONLY.
--
-- Reconstructed from what the repository evidences about the deployed
-- database (tools/collective/settle_finals.js, sync_schedule.js,
-- supabase/functions/collective_public, the NCAAF linker migration):
--   collective.games   (id, sport_code, season, week, kickoff_at, home_team_id,
--                       away_team_id, status, external_ref, created_at)
--   collective.results (game_id, home_score, away_score, closing_spread,
--                       closing_total, closing_home_ml_prob, source, settled_at)
--   collective.teams   (id, sport_code, code <= 10 chars, name)
--   collective.team_aliases (sport_code, alias, team_id)
--   collective.game_detail  the view every board read goes through
--   collective.grades  one row per projection
--   collective.projections  append-only (block_mutation honours the
--                           collective.maintenance switch)
--   odds.events        (league, home_code, away_code, commence_date,
--                       collective_game_id, season, week, last_updated, ...)
--   public.signals / public.signal_ticks  EdgeDesk's own capture
-- Where this is a guess it is a guess about SHAPE; the migration under test
-- discovers columns rather than assuming them.
-- ===========================================================================
\set ON_ERROR_STOP on

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema if not exists collective;
create schema if not exists odds;
grant usage on schema collective to anon, authenticated, service_role;

create table collective.config (key text primary key, value jsonb not null);
create or replace function collective.get_config(p_key text) returns jsonb
language sql stable as $$ select value from collective.config where key = p_key $$;
insert into collective.config values ('submission.lock_minutes', '30');
create or replace function collective.lock_minutes() returns integer
language sql stable as $$ select coalesce((collective.get_config('submission.lock_minutes') #>> '{}')::int, 30) $$;

create table collective.sports (code text primary key, name text not null);
insert into collective.sports values ('NFL', 'Football'), ('CFB', 'College Football'), ('MLB', 'Baseball');

create table collective.creators (id uuid primary key default gen_random_uuid(), slug text unique not null, display_name text not null);
create table collective.models (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references collective.creators(id),
  slug text not null, name text not null, sport_code text not null default 'NFL',
  unique (creator_id, slug)
);

create table collective.teams (
  id uuid primary key default gen_random_uuid(),
  sport_code text not null,
  code text not null,
  name text,
  unique (sport_code, code)
);
create table collective.team_aliases (
  id bigserial primary key,
  sport_code text not null,
  alias text not null,
  team_id uuid not null references collective.teams(id)
);

create table collective.games (
  id uuid primary key default gen_random_uuid(),
  sport_code text not null,
  season integer not null,
  week integer,
  kickoff_at timestamptz not null,
  home_team_id uuid references collective.teams(id),
  away_team_id uuid references collective.teams(id),
  status text not null default 'scheduled',
  external_ref text,
  created_at timestamptz not null default now()
);
create table collective.results (
  game_id uuid primary key references collective.games(id),
  home_score integer, away_score integer,
  closing_spread numeric, closing_total numeric, closing_home_ml_prob numeric,
  source text, settled_at timestamptz not null default now()
);
create view collective.game_detail as
select g.id as game_id, g.sport_code as sport, g.season, g.week, g.kickoff_at, g.status,
       ht.code as home, at.code as away, at.code || ' @ ' || ht.code as label,
       r.home_score, r.away_score, r.closing_spread, r.closing_total
  from collective.games g
  join collective.teams ht on ht.id = g.home_team_id
  join collective.teams at on at.id = g.away_team_id
  left join collective.results r on r.game_id = g.id;

create table collective.projections (
  id uuid primary key default gen_random_uuid(),
  model_id uuid not null references collective.models(id),
  game_id uuid references collective.games(id),
  received_at timestamptz not null default now(),
  data_origin text not null default 'live',
  resolution_status text not null default 'resolved',
  is_late boolean not null default false,
  is_graded_candidate boolean not null default false,
  pick_side text,
  projected_spread numeric,
  projected_total numeric,
  proj_home_score numeric,
  proj_away_score numeric,
  home_win_prob numeric,
  line_at_submission numeric
);
create or replace function collective.block_mutation() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('collective.maintenance', true), '') <> 'on' then
    raise exception 'collective.projections is append-only (set collective.maintenance to change it)';
  end if;
  return coalesce(old, new);
end $$;
create trigger projections_block_mutation before update or delete on collective.projections
  for each row execute function collective.block_mutation();

create table collective.grades (
  projection_id uuid primary key references collective.projections(id),
  pick_result text, margin_error numeric, brier numeric,
  graded_at timestamptz not null default now()
);

-- The LEGACY grader, as the audit found it: a STATED pick side only, against
-- whatever close results holds, writing the graded candidate's grade row.
create or replace function collective.grade_game(p_game_id uuid) returns jsonb
language plpgsql as $$
declare r record; n int := 0; m numeric; cl numeric;
begin
  select home_score, away_score, closing_spread into r from collective.results where game_id = p_game_id;
  if r.home_score is null then return jsonb_build_object('graded', 0); end if;
  m := r.home_score - r.away_score; cl := r.closing_spread;
  insert into collective.grades (projection_id, pick_result, margin_error, brier)
  select p.id,
         case when cl is null or p.pick_side is null then null
              when m + cl = 0 then 'push'
              when (p.pick_side = 'home') = (m + cl > 0) then 'win' else 'loss' end,
         case when p.projected_spread is not null then abs(-p.projected_spread - m) end,
         case when p.home_win_prob is not null and m <> 0 then power(p.home_win_prob - case when m > 0 then 1 else 0 end, 2) end
    from collective.projections p
   where p.game_id = p_game_id and p.is_graded_candidate
  on conflict (projection_id) do update set pick_result = excluded.pick_result,
    margin_error = excluded.margin_error, brier = excluded.brier;
  get diagnostics n = row_count;
  return jsonb_build_object('graded', n, 'grader', 'legacy');
end $$;

-- ---- the Collective's odds feed -------------------------------------------------
create table odds.events (
  event_id text primary key,
  league text not null,
  commence_time timestamptz not null,
  home_team text, away_team text,
  home_code text, away_code text,
  commence_date date,
  espn_id text,
  collective_game_id uuid,
  season integer, week integer,
  last_updated timestamptz default now()
);
create table odds.lines (
  id bigserial primary key,
  event_id text not null references odds.events(event_id),
  book text not null,
  market text not null,
  outcome text not null,
  point numeric,
  price integer,
  captured_at timestamptz not null
);
-- a view of CURRENT prices: must never be read as history
create view odds.board as
select l.event_id, l.book, l.market, l.outcome, l.point, now() as updated_at from odds.lines l;

-- ---- EdgeDesk's own capture --------------------------------------------------------
create table public.signals (
  sig_key text primary key,
  event_id text not null,
  sport_key text not null,
  market text not null,
  selection text not null,
  point numeric,
  commence_time timestamptz not null,
  home_team text, away_team text,
  last_seen_at timestamptz,
  n_books integer
);
create table public.signal_ticks (
  id bigserial primary key,
  sig_key text not null references public.signals(sig_key),
  created_at timestamptz not null,
  point numeric,
  n_books integer
);
create index signal_ticks_sig_created_idx on public.signal_ticks (sig_key, created_at);
