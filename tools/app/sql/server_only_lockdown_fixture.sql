-- ===========================================================================
-- The state the August ship-gate audit read off the live catalog, rebuilt
-- (PR #14, BACKEND_RLS_VERIFICATION.md). TESTING ONLY. Applied after
-- tools/games/sql/supabase_shim.sql and before supabase/server_only_lockdown.sql.
--
-- What it reproduces:
--   * collective is exposed to the API, so anon and authenticated hold USAGE
--     on it, and EXECUTE on every routine in it (the dump read anon=X,
--     authenticated=X).
--   * public.edge_call and the five helpers are executable by both roles.
--   * the three financial views are SELECTable by both.
--   * service_role holds NOTHING explicit on any of it. It reaches all of it
--     through PUBLIC, the PostgreSQL default, which is exactly the case where a
--     revoke from PUBLIC alone would cut the Collective edge functions off.
--
-- And what must survive the lockdown untouched:
--   * public.has_active_sub, which RLS policies call as the signed-in user.
--   * public.collective_model_ensure / collective_my_models, the browser's
--     SECURITY DEFINER wrappers into the Collective (granted the way
--     supabase/collective_model_autocreate.sql grants them).
--   * public.public_home_board, standing in for every public function the
--     browser calls that the lockdown does not name.
-- ===========================================================================

create schema if not exists collective;
grant usage on schema collective to anon, authenticated;

create table if not exists collective.config (key text primary key, value text);
create table if not exists collective.subscribers (user_id uuid primary key, status text not null);
alter table collective.config enable row level security;
alter table collective.subscribers enable row level security;
insert into collective.config values
  ('admin.user_ids', '["00000000-0000-0000-0000-00000000000a"]')
on conflict (key) do nothing;

create or replace function collective.get_config(p_key text) returns text
language sql stable security definer set search_path = collective, pg_temp as $$
  select value from collective.config where key = p_key
$$;
-- An overload, so "every overload" is tested rather than assumed.
create or replace function collective.get_config() returns jsonb
language sql stable security definer set search_path = collective, pg_temp as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from collective.config
$$;
create or replace function collective.billing_upsert_subscriber(p_user uuid, p_status text) returns void
language sql security definer set search_path = collective, pg_temp as $$
  insert into collective.subscribers values (p_user, p_status)
  on conflict (user_id) do update set status = excluded.status
$$;
create or replace procedure collective.nightly_sweep()
language sql as $$ select 1 $$;
create or replace function collective.touch() returns trigger
language plpgsql as $$ begin return new; end $$;

grant execute on all routines in schema collective to anon, authenticated;

create or replace function public.edge_call(p_slug text, p_body jsonb, p_timeout_ms integer, p_query text)
returns text language sql security definer as $$ select 'called ' || p_slug $$;
create or replace function public.guarantee_sweep() returns integer
language sql security definer as $$ select 0 $$;
create or replace function public.research_set_status(p_id uuid, p_status text, p_note text) returns void
language plpgsql security definer as $$ begin end $$;
create or replace function public.research_rebuild_patterns(p_days integer) returns integer
language sql security definer as $$ select 0 $$;
create or replace function public.research_register_validation(p_id uuid, p_n integer, p_x numeric, p_j jsonb, p_b boolean) returns void
language plpgsql security definer as $$ begin end $$;
create or replace function public.research_complete_validation(p_id uuid, p_n integer, p_x numeric, p_y numeric) returns void
language plpgsql security definer as $$ begin end $$;
grant execute on function
  public.edge_call(text, jsonb, integer, text),
  public.guarantee_sweep(),
  public.research_set_status(uuid, text, text),
  public.research_rebuild_patterns(integer),
  public.research_register_validation(uuid, integer, numeric, jsonb, boolean),
  public.research_complete_validation(uuid, integer, numeric, numeric)
to anon, authenticated;

create table if not exists public.ai_usage (user_id uuid, cost numeric);
alter table public.ai_usage enable row level security;
insert into public.ai_usage values
  ('00000000-0000-0000-0000-0000000000b1', 1.25),
  ('00000000-0000-0000-0000-0000000000b2', 4.00);
create or replace view public.ai_cost_per_user as
  select user_id, sum(cost) as cost from public.ai_usage group by user_id;
create or replace view public.guarantee_refunds_due as
  select user_id, cost as refund from public.ai_usage;
create or replace view public.partner_rollup as
  select count(*) as users, sum(cost) as revenue from public.ai_usage;
grant select on public.ai_cost_per_user, public.guarantee_refunds_due, public.partner_rollup
  to anon, authenticated;

create or replace function public.has_active_sub() returns boolean
language sql stable security definer as $$ select auth.uid() is not null $$;
grant execute on function public.has_active_sub() to authenticated;

create or replace function public.collective_model_ensure(p_sport text, p_name text) returns text
language sql security definer set search_path = public, pg_temp as $$
  select collective.get_config('admin.user_ids')
$$;
revoke all on function public.collective_model_ensure(text, text) from public, anon;
grant execute on function public.collective_model_ensure(text, text) to authenticated, service_role;
create or replace function public.collective_my_models() returns jsonb
language sql security definer set search_path = public, pg_temp as $$
  select collective.get_config()
$$;
revoke all on function public.collective_my_models() from public, anon;
grant execute on function public.collective_my_models() to authenticated, service_role;

create or replace function public.public_home_board() returns text
language sql stable as $$ select 'board' $$;
