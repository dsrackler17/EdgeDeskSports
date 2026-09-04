-- ===========================================================================
-- A Supabase shim, for TESTING ONLY. Never applied to the real project.
--
-- supabase/games_social.sql is written against auth.uid(), auth.users and the
-- anon / authenticated / service_role roles. This recreates just enough of that
-- to run the real file, unmodified, against a stock PostgreSQL — so the RLS
-- policies and the security-definer functions are exercised as written rather
-- than reasoned about.
--
-- auth.uid() reads a session GUC, which is how the tests switch player.
-- ===========================================================================
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

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to authenticated, service_role;

-- Supabase grants anon and authenticated full table DML on the public schema
-- and relies on ROW LEVEL SECURITY to decide what they may actually touch.
-- Reproducing that here matters: without these grants the tests would pass for
-- the wrong reason — "permission denied" instead of "RLS returned no rows" —
-- and would not be testing the policies at all.
alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to anon, authenticated;
alter default privileges for role postgres in schema public
  grant usage, select on sequences to anon, authenticated;
