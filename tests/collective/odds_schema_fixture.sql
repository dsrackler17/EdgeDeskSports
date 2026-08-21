-- Stand-in for the parts of the deployed Supabase project that the odds
-- migration touches, so the migration can be applied and exercised on a plain
-- Postgres instance. Nothing here is deployed: production already has these.
--
--   roles           anon / authenticated / service_role  (Supabase built-ins)
--   collective      the schema the Collective API already uses
--   game_detail     the view the public API reads, with exactly the columns
--                   supabase/functions/collective_public/index.ts declares
--   team_aliases    the alias table the admin quarantine flow writes to
--
-- Column names come from the deployed collective_public source, not guesswork.

do $$
begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;

create schema if not exists collective;

create table if not exists collective.games (
  id             uuid primary key default gen_random_uuid(),
  sport          text not null,
  season         integer not null,
  week           integer,
  kickoff_at     timestamptz not null,
  status         text not null default 'scheduled',
  home           text not null,
  away           text not null,
  home_score     integer,
  away_score     integer,
  closing_spread numeric,
  closing_total  numeric
);

create or replace view collective.game_detail as
  select g.id as game_id, g.sport, g.season, g.week, g.kickoff_at, g.status,
         g.home, g.away, (g.away || ' @ ' || g.home) as label,
         g.home_score, g.away_score, g.closing_spread, g.closing_total
  from collective.games g;

create table if not exists collective.team_aliases (
  sport_code text not null,
  alias      text not null,
  team_code  text not null,
  primary key (sport_code, alias)
);
