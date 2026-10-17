-- =============================================================================
-- cfb_altitude — the Postgres half of the CFB Altitude & Travel module
-- (football/altitude; docs/cfb-altitude/README.md).
--
-- WHAT IT IS
--   The venue elevation registry as each build published it
--   (cfb_venue_elevation: stable venue id, elevation, provenance, confidence),
--   the per-game altitude record frozen before kickoff (cfb_altitude_shadow:
--   the measured context, the SHADOW adjustment, the points actually applied,
--   the V1 margin it sat beside, the flag and parameter state that decided it),
--   and every research run's verdict (cfb_altitude_validation_runs: status,
--   gates, support). Typed columns for what is queried, `payload jsonb` for the
--   complete record exactly as the module wrote it. It also declares the guarded
--   switch cfb_altitude_adjustment_enabled in public.cfb_feature_flags.
--
-- THE RULES, ENFORCED BY THE SERVER
--   1. Append-only. BEFORE UPDATE / DELETE / TRUNCATE triggers refuse every
--      change, the service role included. A new registry or a new pregame
--      record is a new row; nothing historical is rewritten.
--   2. Exactly once per natural key.
--   3. Point in time: a pregame altitude record is written before kickoff.
--   4. SHADOW BY DEFAULT. applied_points is 0 unless the row says APPLIED, the
--      flag was on AND the parameters were VALIDATED; it never exceeds the
--      3-point cap; the published margin is the V1 margin plus what was
--      applied; a neutral site is never adjusted.
--   5. A research run may claim points_applied only when its status is
--      VALIDATED.
--   6. The switch is GUARDED: cfb_set_feature_flag (supabase/cfb_production.sql)
--      refuses to turn it on without an evidence reference and a person.
--   7. Who reads what: authenticated may SELECT; anon nothing; writes only
--      from the service role (insert).
--
-- DEPENDS ON supabase/cfb_production.sql for the flag table only. Applied
-- without it, everything else is created and the report says the flag was
-- not seeded. Apply order: football/cfb_production/migration_review.js ORDER.
--
-- ROLLBACK: switch the flag off (docs/cfb-altitude/ROLLBACK.md). Removing the
-- objects entirely is supabase/altitude_shadow_rollback.sql.
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- Tested against a real PostgreSQL by football/altitude/sql.test.js.
-- =============================================================================

set lock_timeout = '5s';

create table if not exists public.cfb_venue_elevation (
  elevation_id            text primary key,
  venue_id                int not null,
  name                    text not null,
  elev_ft                 numeric not null,
  elev_m                  numeric,
  confidence              text not null,
  elev_source             text not null,
  basis                   text not null,
  legacy_of               int,
  same_site_as            int,
  lat                     double precision,
  lon                     double precision,
  tz_name                 text,
  sources                 jsonb not null,
  registry_generated_at   timestamptz not null,
  run_id                  text,
  recorded_at             timestamptz not null default now(),
  constraint cfb_venue_elevation_id check (elevation_id ~ '^cfbve_[0-9a-f]{24}$'),
  constraint cfb_venue_elevation_conf check (confidence in ('HIGH','MEDIUM','LOW')),
  constraint cfb_venue_elevation_range check (elev_ft between -300 and 15000),
  constraint cfb_venue_elevation_sources check (jsonb_typeof(sources) = 'array' and jsonb_array_length(sources) >= 1),
  constraint cfb_venue_elevation_legacy check (legacy_of is null or confidence <> 'HIGH')
);
create unique index if not exists cfb_venue_elevation_key
  on public.cfb_venue_elevation (venue_id, registry_generated_at);
comment on table public.cfb_venue_elevation is
  'football/altitude/venues.json as each build published it: elevation by stable venue id, with sources and confidence. A missing venue is absent, never imputed.';

create table if not exists public.cfb_altitude_shadow (
  shadow_id                text primary key,
  game_id                  text not null,
  season                   int not null,
  week                     int,
  kickoff_ts               timestamptz not null,
  prediction_ts            timestamptz not null,
  baseline_model_version   text not null,
  altitude_model_version   text not null,
  candidate                text,
  params_status            text not null,
  status                   text not null,
  flag_enabled             boolean not null default false,
  neutral_site             boolean not null,
  baseline_home_margin     numeric,
  shadow_points            numeric,
  applied_points           numeric not null default 0,
  published_home_margin    numeric,
  venue_id                 int,
  game_elev_ft             numeric,
  home_usual_elev_ft       numeric,
  away_usual_elev_ft       numeric,
  home_gain_ft             numeric,
  away_gain_ft             numeric,
  exposure_class           text,
  distance_mi              numeric,
  tz_change_h              numeric,
  run_id                   text,
  payload                  jsonb not null,
  recorded_at              timestamptz not null default now(),
  constraint cfb_altitude_shadow_id check (shadow_id ~ '^cfbalt_[0-9a-f]{24}$'),
  constraint cfb_altitude_shadow_pit check (prediction_ts < kickoff_ts),
  constraint cfb_altitude_shadow_status check (status in ('SHADOW','APPLIED','NOT_APPLICABLE','UNAVAILABLE')),
  constraint cfb_altitude_shadow_params check (params_status in ('VALIDATED','CANDIDATE','RESEARCH_ONLY','REJECTED','NONE')),
  constraint cfb_altitude_shadow_exposure check (exposure_class is null or exposure_class in ('HIGH','MODERATE','MINIMAL','DESCENT','UNKNOWN')),
  constraint cfb_altitude_shadow_cap check (abs(applied_points) <= 3 and (shadow_points is null or abs(shadow_points) <= 3)),
  -- the three locks: a point moves only when the row is APPLIED, the flag was on and the parameters were VALIDATED
  constraint cfb_altitude_shadow_locks check (applied_points = 0 or (status = 'APPLIED' and flag_enabled and params_status = 'VALIDATED')),
  constraint cfb_altitude_shadow_applied check (status <> 'APPLIED' or (flag_enabled and params_status = 'VALIDATED')),
  constraint cfb_altitude_shadow_neutral check (not neutral_site or (status in ('NOT_APPLICABLE','UNAVAILABLE') and applied_points = 0)),
  constraint cfb_altitude_shadow_sum check (baseline_home_margin is null or published_home_margin is null
    or abs(published_home_margin - (baseline_home_margin + applied_points)) < 0.002),
  constraint cfb_altitude_shadow_payload check (payload ->> 'schema' = 'edgedesk_cfb_altitude_section_v1')
);
create unique index if not exists cfb_altitude_shadow_key
  on public.cfb_altitude_shadow (game_id, prediction_ts, altitude_model_version);
create index if not exists cfb_altitude_shadow_season on public.cfb_altitude_shadow (season, week);
comment on table public.cfb_altitude_shadow is
  'Pregame altitude record per game x build: measured context, SHADOW adjustment, points applied (0 unless validated and switched on), and the V1 margin beside it.';

create table if not exists public.cfb_altitude_validation_runs (
  validation_id     text primary key,
  model_version     text not null,
  generated_at      timestamptz not null,
  declared_gates    date not null,
  status            text not null,
  points_applied    boolean not null,
  support_state     text not null,
  selected          text,
  gates             jsonb not null,
  payload           jsonb not null,
  recorded_at       timestamptz not null default now(),
  constraint cfb_altitude_validation_id check (validation_id ~ '^cfbav_[0-9a-f]{24}$'),
  constraint cfb_altitude_validation_status check (status in ('VALIDATED','CANDIDATE','RESEARCH_ONLY','REJECTED')),
  constraint cfb_altitude_validation_support check (support_state in ('SUPPORTED','SUGGESTIVE','NOT_ESTABLISHED')),
  constraint cfb_altitude_validation_points check (not points_applied or status = 'VALIDATED'),
  constraint cfb_altitude_validation_supported check (support_state <> 'SUPPORTED' or status = 'VALIDATED'),
  constraint cfb_altitude_validation_gates check (jsonb_typeof(gates) = 'array')
);
create unique index if not exists cfb_altitude_validation_key
  on public.cfb_altitude_validation_runs (model_version, generated_at);
comment on table public.cfb_altitude_validation_runs is
  'Every altitude research run (football/altitude/research/run.js): status, gates, support. Points apply only from a VALIDATED run.';

-- ===================================================== append-only + access
create or replace function public.cfb_altitude_append_only()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $fn$
begin
  if tg_op = 'UPDATE' then
    raise exception '% is append-only: rows are never updated (a new build writes a new row)', tg_table_name
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
  foreach t in array array['cfb_venue_elevation','cfb_altitude_shadow','cfb_altitude_validation_runs']
  loop
    if not exists (select 1 from pg_trigger where tgrelid = to_regclass('public.' || t) and tgname = t || '_no_update_trg') then
      execute format('create trigger %I before update on public.%I for each row execute function public.cfb_altitude_append_only()', t || '_no_update_trg', t);
    end if;
    if not exists (select 1 from pg_trigger where tgrelid = to_regclass('public.' || t) and tgname = t || '_no_delete_trg') then
      execute format('create trigger %I before delete on public.%I for each row execute function public.cfb_altitude_append_only()', t || '_no_delete_trg', t);
    end if;
    if not exists (select 1 from pg_trigger where tgrelid = to_regclass('public.' || t) and tgname = t || '_no_truncate_trg') then
      execute format('create trigger %I before truncate on public.%I for each statement execute function public.cfb_altitude_append_only()', t || '_no_truncate_trg', t);
    end if;
    if not (select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.' || t)) then
      execute format('alter table public.%I enable row level security', t);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_read') then
      execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_read', t);
    end if;
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

-- The registry each venue id currently resolves to.
create or replace view public.cfb_venue_elevation_current as
select distinct on (v.venue_id) v.*
  from public.cfb_venue_elevation v
 order by v.venue_id, v.registry_generated_at desc, v.recorded_at desc;

-- The latest pregame altitude record per game (what the product showed last).
create or replace view public.cfb_altitude_shadow_latest as
select distinct on (s.game_id) s.*
  from public.cfb_altitude_shadow s
 order by s.game_id, s.prediction_ts desc, s.recorded_at desc;

-- MONITORING. Per season, week and exposure: how many games, how many were
-- usable, the shadow it would have applied, and the points actually applied —
-- which must be zero while the module is SHADOW. Grading against finals is
-- football/altitude/monitor.js. Never a trigger by itself.
create or replace view public.cfb_altitude_monitor as
select l.season, l.week, coalesce(l.exposure_class, 'UNKNOWN') as exposure_class,
       count(*) as games,
       count(*) filter (where l.status in ('SHADOW','APPLIED')) as usable,
       count(*) filter (where l.status = 'UNAVAILABLE') as unavailable,
       count(*) filter (where l.status = 'APPLIED') as applied_games,
       round(avg(l.shadow_points) filter (where l.status in ('SHADOW','APPLIED')), 3) as mean_shadow_points,
       round(coalesce(sum(abs(l.applied_points)), 0), 3) as total_abs_points_applied,
       bool_or(l.flag_enabled) as flag_seen_on
  from public.cfb_altitude_shadow_latest l
 group by l.season, l.week, coalesce(l.exposure_class, 'UNKNOWN');

do $blk$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant select on public.cfb_venue_elevation_current to authenticated';
    execute 'grant select on public.cfb_altitude_shadow_latest to authenticated';
    execute 'grant select on public.cfb_altitude_monitor to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.cfb_venue_elevation_current from anon';
    execute 'revoke all on public.cfb_altitude_shadow_latest from anon';
    execute 'revoke all on public.cfb_altitude_monitor from anon';
  end if;
end $blk$;

-- ============================================================ the switch
-- Declared once, OFF, guarded; a re-apply never resets a person's switch.
do $blk$
begin
  if to_regclass('public.cfb_feature_flags') is not null then
    execute $ins$
      insert into public.cfb_feature_flags (flag, enabled, kind, guarded, description, updated_by, reason) values
        ('cfb_altitude_adjustment_enabled', false, 'COMPONENT', true,
         'The altitude residual adjustment (football/altitude) may move the V1 fair spread. Effective only while football/altitude/params.js is VALIDATED with points_applied; off, the adjustment is SHADOW and moves 0 points.',
         'cfb_altitude seed', 'initial state: the altitude adjustment did not pass its gates (football/validation/altitude_cfb.json) and is shadow research')
      on conflict (flag) do nothing
    $ins$;
  end if;
end $blk$;

notify pgrst, 'reload schema';

-- ================================================================= report
with tables(t) as (
  values ('cfb_venue_elevation'),('cfb_altitude_shadow'),('cfb_altitude_validation_runs')
)
select check_name, status from (
  select 1 as ord, 'table ' || t || ': exists, append-only, row level security' as check_name,
         case when to_regclass('public.' || t) is not null
               and (select count(*) from pg_trigger tg where tg.tgrelid = to_regclass('public.' || t)
                     and tg.tgname in (t || '_no_update_trg', t || '_no_delete_trg', t || '_no_truncate_trg')) = 3
               and (select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.' || t))
              then 'ok' else 'CHECK THIS' end as status
    from tables
  union all
  select 2, 'exactly-once keys (registry, pregame record, validation run)',
         case when to_regclass('public.cfb_venue_elevation_key') is not null
               and to_regclass('public.cfb_altitude_shadow_key') is not null
               and to_regclass('public.cfb_altitude_validation_key') is not null then 'ok' else 'CHECK THIS' end
  union all
  select 3, 'views: cfb_venue_elevation_current, cfb_altitude_shadow_latest, cfb_altitude_monitor',
         case when to_regclass('public.cfb_venue_elevation_current') is not null
               and to_regclass('public.cfb_altitude_shadow_latest') is not null
               and to_regclass('public.cfb_altitude_monitor') is not null then 'ok' else 'CHECK THIS' end
  union all
  select 4, 'shadow by default (three locks, cap 3, published = V1 + applied, neutral never adjusted, before kickoff)',
         case when (select count(*) from pg_constraint where conname in ('cfb_altitude_shadow_locks','cfb_altitude_shadow_applied',
                     'cfb_altitude_shadow_cap','cfb_altitude_shadow_sum','cfb_altitude_shadow_neutral','cfb_altitude_shadow_pit')) = 6
              then 'ok' else 'CHECK THIS' end
  union all
  select 5, 'switch cfb_altitude_adjustment_enabled declared, guarded'
         || case when to_regclass('public.cfb_feature_flags') is null then ' (skipped: supabase/cfb_production.sql not applied)' else '' end,
         -- read through query_to_xml so the report still plans when the flag table does not exist
         case when to_regclass('public.cfb_feature_flags') is null then 'ok'
              when (xpath('/row/n/text()', query_to_xml(
                     'select count(*) as n from public.cfb_feature_flags where flag = ''cfb_altitude_adjustment_enabled'' and guarded',
                     false, true, '')))[1]::text = '1' then 'ok'
              else 'CHECK THIS' end
) r
order by ord, check_name;
