-- ===========================================================================
-- A COLLECTIVE SCHEMA, FOR TESTING ONLY. Never applied to the real project.
--
-- The Collective's schema is not in this repository: it was built from the
-- Supabase dashboard, like every edge function except collective_ingest. So
-- supabase/collective_member_removal.sql is written by DISCOVERY — it reads
-- the tables, the columns and the foreign keys out of the catalog at call
-- time — and this file is the schema those discoveries are exercised against.
--
-- Everything here is RECONSTRUCTED from what the repository actually evidences:
--
--   collective.projections, .games, .config, .creators, .models   lock_rule.sql,
--     collective/admin.html, collective/index.html, collective/AUDIT.md
--   is_graded_candidate, is_late, resolution_status, data_origin, received_at
--                                                                lock_rule.sql
--   the append-only trigger and the collective.maintenance switch it honours
--                                                                lock_rule.sql
--   creator_slug / display_name / founding / account_status / joined_at /
--     key_prefixes / origins / models[].{name,slug,sport,source_kind}
--                                                       collective/admin.html
--   admin.user_ids as the admin allowlist                collective/AUDIT.md
--   consensus / model_records / model_coverage_totals as VIEWS  lock_rule.sql
--
-- Plus the shapes a removal has to survive that the repository does not pin
-- down: a CACHED aggregate table, a MATERIALIZED view, a rebuild routine, a
-- financial ledger, and a snapshot table an operator may choose to protect.
-- Where this fixture is a guess it is a guess about SHAPE, and the code under
-- test never names any of these tables.
-- ===========================================================================
\set ON_ERROR_STOP on

create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema if not exists collective;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to authenticated, service_role;

-- ---- configuration ---------------------------------------------------------
create table if not exists collective.config (
  key text primary key,
  value jsonb not null
);
create or replace function collective.get_config(p_key text) returns jsonb
language sql stable set search_path = collective, public as $$
  select value from collective.config where key = p_key;
$$;

-- ---- identity --------------------------------------------------------------
create table if not exists collective.creators (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id),
  slug text unique not null,
  display_name text not null,
  description text,
  website_url text,
  founding_member boolean not null default false,
  account_status text not null default 'active',
  joined_at timestamptz not null default now()
);

create table if not exists collective.models (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references collective.creators(id),
  slug text not null,
  name text not null,
  sport text not null default 'NFL',
  source_kind text,
  source_ref text,
  created_at timestamptz not null default now(),
  unique (creator_id, slug)
);

-- credentials and access grants: what "revoke access" has to reach
create table if not exists collective.api_keys (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references collective.creators(id),
  model_id uuid references collective.models(id),
  key_prefix text not null,
  key_hash text not null,
  created_at timestamptz not null default now()
);
create table if not exists collective.embed_origins (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references collective.creators(id),
  origin text not null
);
create table if not exists collective.invites (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid references collective.creators(id),
  display_name text,
  email text,
  token_hash text,
  status text not null default 'sent',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days'
);

-- ---- shared market data: never a member's to delete -------------------------
create table if not exists collective.games (
  id uuid primary key default gen_random_uuid(),
  sport_code text not null default 'NFL',
  season integer not null default 2026,
  week integer,
  kickoff_at timestamptz not null,
  home_team text,
  away_team text
);
create table if not exists collective.game_results (
  game_id uuid primary key references collective.games(id),
  home_score integer,
  away_score integer,
  closing_spread numeric,
  closing_total numeric,
  settled_at timestamptz not null default now()
);
create table if not exists collective.team_aliases (
  id bigserial primary key,
  sport_code text not null,
  alias text not null,
  team_code text not null
);

-- ---- the submissions themselves ---------------------------------------------
create table if not exists collective.projections (
  id uuid primary key default gen_random_uuid(),
  model_id uuid not null references collective.models(id),
  game_id uuid references collective.games(id),
  received_at timestamptz not null default now(),
  data_origin text not null default 'live',
  resolution_status text not null default 'resolved',
  is_late boolean not null default false,
  is_graded_candidate boolean not null default false,
  spread numeric,
  total numeric,
  home_ml_prob numeric,
  result text,                       -- null until the game settles
  raw_game_ref text,
  raw_row jsonb
);

create table if not exists collective.projection_grades (
  id uuid primary key default gen_random_uuid(),
  projection_id uuid not null unique references collective.projections(id),
  graded_at timestamptz not null default now(),
  ats_result text,
  total_result text,
  clv numeric
);

create table if not exists collective.consensus_contributions (
  id uuid primary key default gen_random_uuid(),
  projection_id uuid not null references collective.projections(id),
  game_id uuid not null references collective.games(id),
  weight numeric not null default 1
);

create table if not exists collective.calibration_samples (
  id uuid primary key default gen_random_uuid(),
  model_id uuid not null references collective.models(id),
  bucket integer not null,
  predicted numeric not null,
  actual integer not null
);

-- A CACHED aggregate: not a view, so it only becomes correct if the removal
-- deletes its rows or a rebuild routine puts them back.
create table if not exists collective.model_record_cache (
  model_id uuid primary key references collective.models(id),
  wins integer not null default 0,
  losses integer not null default 0,
  pushes integer not null default 0,
  rebuilt_at timestamptz
);

-- An immutable-looking historical snapshot. Deleted by default; an operator who
-- wants it kept names it in collective.member_removal.extra_protected.
create table if not exists collective.consensus_snapshots (
  id uuid primary key default gen_random_uuid(),
  projection_id uuid not null references collective.projections(id),
  taken_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb
);

-- Money. Never deleted by a member removal, in either mode.
create table if not exists collective.earnings_ledger (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references collective.creators(id),
  month text not null,
  earned_cents bigint not null default 0
);

-- ---- what the product actually reads ----------------------------------------
-- Derived from the source rows, so a deletion is reflected the instant it
-- commits. This is the property section 12 of the brief is about.
create or replace view collective.consensus as
  select p.game_id,
         count(*) as n_models,
         avg(p.spread) as consensus_spread,
         avg(p.home_ml_prob) as consensus_home_ml_prob
    from collective.projections p
   where p.is_graded_candidate and not p.is_late and p.resolution_status = 'resolved'
   group by p.game_id;

create or replace view collective.model_records as
  select m.id as model_id, m.slug as model_slug, c.slug as creator_slug,
         count(*) filter (where p.result = 'win')  as wins,
         count(*) filter (where p.result = 'loss') as losses,
         count(*) filter (where p.result = 'push') as pushes,
         count(*) filter (where p.result is not null) as graded
    from collective.models m
    join collective.creators c on c.id = m.creator_id
    left join collective.projections p on p.model_id = m.id and p.is_graded_candidate
   group by m.id, m.slug, c.slug;

create or replace view collective.model_coverage_totals as
  select m.id as model_id, count(distinct p.game_id) as games_covered
    from collective.models m
    left join collective.projections p on p.model_id = m.id
   group by m.id;

create materialized view if not exists collective.leaderboard_mv as
  select model_id, wins, losses, pushes, graded from collective.model_records;

-- The rebuild routine a removal has to find and run.
create or replace function collective.rebuild_model_record_cache() returns void
language plpgsql set search_path = collective, public as $$
begin
  delete from collective.model_record_cache;
  insert into collective.model_record_cache (model_id, wins, losses, pushes, rebuilt_at)
  select model_id, wins, losses, pushes, now() from collective.model_records;
end $$;

-- ---- the append-only rule the removal has to know about ----------------------
-- lock_rule.sql refers to "the maintenance switch the append-only trigger
-- already honours". This is that trigger: without setting the switch, a delete
-- on projections is refused — which is exactly the failure a removal written
-- without knowing about it would hit.
create or replace function collective.block_mutation() returns trigger
language plpgsql set search_path = collective, public as $$
begin
  if coalesce(current_setting('collective.maintenance', true), '') <> 'on' then
    raise exception 'collective.projections is append-only (set collective.maintenance to change it)';
  end if;
  return coalesce(old, new);
end $$;

drop trigger if exists projections_block_mutation on collective.projections;
create trigger projections_block_mutation
  before update or delete on collective.projections
  for each row execute function collective.block_mutation();
