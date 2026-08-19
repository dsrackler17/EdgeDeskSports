-- Model Collective, migration 1: schema, enums, config, sports, teams, games.
-- Forward-only. The collective schema is the separation seam (rule 8.1): no
-- object in it references any other schema, so it lifts into its own project
-- with a schema dump and a DNS change.

create schema if not exists collective;

-- PostgREST may expose this schema, but only service_role may enter it.
-- anon and authenticated get nothing, not even usage (defense: RLS is also
-- enabled with no policies on every table).
revoke all on schema collective from public;
grant usage on schema collective to service_role;
alter default privileges in schema collective grant select on tables to service_role;

-- ---------------------------------------------------------------- enums

create type collective.data_origin       as enum ('live','backfill','test');
create type collective.resolution_status as enum ('resolved','quarantined');
create type collective.pick_side         as enum ('home','away');
create type collective.total_side        as enum ('over','under');
create type collective.grade_result      as enum ('win','loss','push');
create type collective.game_status       as enum ('scheduled','final','canceled','postponed');
create type collective.key_scope         as enum ('submit');
create type collective.key_status        as enum ('active','revoked');
create type collective.creator_status    as enum ('active','departed');
create type collective.billing_mode      as enum ('referral','wholesale');
create type collective.sub_status        as enum ('active','past_due','canceled','refunded');
create type collective.ledger_type       as enum ('earning','clawback','payout','adjustment');
create type collective.embed_event_type  as enum ('impression','profile_view','outbound_click','collective_click','subscribe_click');

-- ---------------------------------------------------------------- config
-- Every economics number and threshold lives here and only here (Section 5
-- of the build prompt: numbers in config, not scattered through code).

create table collective.config (
  key         text primary key,
  value       jsonb not null,
  description text,
  updated_at  timestamptz not null default now()
);
alter table collective.config enable row level security;
grant select on collective.config to service_role;

create or replace function collective.cfg(p_key text) returns jsonb
language sql stable security definer set search_path = collective as
$$ select value from collective.config where key = p_key $$;

create or replace function collective.cfg_int(p_key text, p_default int) returns int
language sql stable security definer set search_path = collective as
$$ select coalesce((select value from collective.config where key = p_key)::text::int, p_default) $$;

create or replace function collective.cfg_bool(p_key text, p_default boolean) returns boolean
language sql stable security definer set search_path = collective as
$$ select coalesce((select value from collective.config where key = p_key)::text::boolean, p_default) $$;

-- ---------------------------------------------------------------- sports

create table collective.sports (
  code               text primary key,
  name               text not null,
  spread_convention  text not null default 'home',
  active             boolean not null default true
);
alter table collective.sports enable row level security;
grant select on collective.sports to service_role;

create table collective.sport_seasons (
  id          uuid primary key default gen_random_uuid(),
  sport_code  text not null references collective.sports(code),
  season      int  not null,
  starts_on   date not null,
  ends_on     date not null,
  unique (sport_code, season)
);
alter table collective.sport_seasons enable row level security;
grant select on collective.sport_seasons to service_role;

-- ---------------------------------------------------------------- teams

create table collective.teams (
  id          uuid primary key default gen_random_uuid(),
  sport_code  text not null references collective.sports(code),
  code        text not null,
  name        text not null,
  unique (sport_code, code)
);
alter table collective.teams enable row level security;
grant select on collective.teams to service_role;

-- Canonical game resolution is a subsystem, not a string match (rule 8.4).
-- Aliases are the vocabulary; matching is case-insensitive on trimmed text.
create table collective.team_aliases (
  id          uuid primary key default gen_random_uuid(),
  sport_code  text not null references collective.sports(code),
  alias       text not null,
  team_id     uuid not null references collective.teams(id)
);
create unique index team_aliases_uniq
  on collective.team_aliases (sport_code, lower(trim(alias)));
alter table collective.team_aliases enable row level security;
grant select, insert on collective.team_aliases to service_role;

-- ---------------------------------------------------------------- games

create table collective.games (
  id            uuid primary key default gen_random_uuid(),
  sport_code    text not null references collective.sports(code),
  season        int  not null,
  week          int,
  kickoff_at    timestamptz not null,
  home_team_id  uuid not null references collective.teams(id),
  away_team_id  uuid not null references collective.teams(id),
  status        collective.game_status not null default 'scheduled',
  external_ref  text,
  created_at    timestamptz not null default now(),
  check (home_team_id <> away_team_id)
);
-- One canonical game per matchup per UTC date (kickoff times shift; dates
-- rarely do, and resolution matches by nearest kickoff anyway).
create unique index games_natural_key
  on collective.games (sport_code, season, home_team_id, away_team_id, ((kickoff_at at time zone 'UTC')::date));
create index games_slate on collective.games (sport_code, season, week);
create index games_kickoff on collective.games (kickoff_at);
alter table collective.games enable row level security;
grant select on collective.games to service_role;
