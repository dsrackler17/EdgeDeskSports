-- =============================================================================
-- cfb_sp_plus — SP+ for college football, stored as an EXTERNAL estimate.
--
-- WHAT IT IS
--   SP+ is ESPN's opponent-adjusted efficiency rating, created by Bill
--   Connelly. EdgeDesk reads it from CollegeFootballData.com (GET
--   /ratings/sp) once a week (football/sp_plus/sync.js, run by
--   .github/workflows/cfb-sp-plus.yml) and keeps every capture here. It is a
--   THIRD-PARTY model (provenance T3, external), never an EdgeDesk model: it
--   feeds no EdgeDesk projection, EV, ranking or grade.
--
--   cfb_sp_ratings    one row per team per weekly capture: overall, offense
--                     and defense, with the source, its version, the payload
--                     hash and the capture time
--   cfb_sp_sync_runs  one row per sync attempt: OK, UNCHANGED or FAILED, with
--                     the reason, the counts and every team name that did not
--                     map (logged, never guessed)
--   cfb_external_estimates
--                     the registry: SP+'s projected line as an EXTERNAL
--                     estimate, with source, version and terms; the server
--                     refuses to mark one an EdgeDesk model or validated
--
-- THE RULES, ENFORCED BY THE SERVER
--   1. Append-only. BEFORE UPDATE, BEFORE DELETE and BEFORE TRUNCATE triggers
--      raise restrict_violation on both tables — the service role bypasses
--      row level security, not triggers. A revised rating is a new capture.
--   2. Raw values stay private. CollegeFootballData's terms (§5) forbid a
--      public mirror of its data, and SP+ belongs to ESPN. Row level security
--      is on with NO policy, and anon and authenticated hold no privilege at
--      all: only the service role reads or writes these rows. The public
--      repository carries only the derived projected line
--      (football/sp_plus/lines.json), never a rating.
--   3. Deterministic ids. prefix + first 24 hex of sha256 of the fields
--      joined with '|', computed by football/sp_plus/cfbd.js, so a re-run of
--      the same capture is a no-op (on_conflict + ignore-duplicates).
--
-- Applied by a person (SQL editor or psql). Idempotent: safe to re-run.
-- Until it is applied, the sync fails closed and publishes no new line.
-- =============================================================================

create table if not exists public.cfb_sp_ratings (
  rating_id       text primary key,
  snapshot_id     text not null,
  season          int not null,
  week            int not null,
  week_key        text not null,
  season_type     text not null,
  team_id         text not null,
  source_team     text not null,
  sp_overall      numeric(6,2) not null,
  sp_off          numeric(6,2) not null,
  sp_def          numeric(6,2) not null,
  source          text not null,
  source_version  text not null,
  payload_sha256  text not null,
  captured_at     timestamptz not null,
  recorded_at     timestamptz not null default now(),
  constraint cfb_sp_rating_id_format check (rating_id ~ '^cfbsp_[0-9a-f]{24}$'),
  constraint cfb_sp_rating_snapshot_format check (snapshot_id ~ '^cfbss_[0-9a-f]{24}$'),
  constraint cfb_sp_rating_season check (season between 2000 and 2100),
  constraint cfb_sp_rating_week check (week between 0 and 25),
  constraint cfb_sp_rating_week_key check (week_key ~ '^[0-9]{4}:[01]:[0-9]{2}$'),
  constraint cfb_sp_rating_season_type check (season_type in ('regular','postseason')),
  constraint cfb_sp_rating_team check (team_id ~ '^[a-z0-9]+$'),
  constraint cfb_sp_rating_values check (abs(sp_overall) < 100 and abs(sp_off) < 100 and abs(sp_def) < 100),
  constraint cfb_sp_rating_hash check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  constraint cfb_sp_rating_one_per_team unique (snapshot_id, team_id)
);
comment on table public.cfb_sp_ratings is
  'SP+ (ESPN, Bill Connelly) via CollegeFootballData.com /ratings/sp: one row per team per weekly capture. EXTERNAL estimate (T3), never an EdgeDesk model. Append-only; service role only (football/sp_plus/README.md).';

create table if not exists public.cfb_sp_sync_runs (
  run_id          text primary key,
  season          int not null,
  week            int,
  week_key        text,
  started_at      timestamptz not null,
  finished_at     timestamptz not null,
  status          text not null,
  reason          text,
  n_received      int not null default 0,
  n_valid         int not null default 0,
  n_mapped        int not null default 0,
  unmapped        jsonb not null default '[]'::jsonb,
  rejected        jsonb not null default '[]'::jsonb,
  payload_sha256  text,
  snapshot_id     text,
  recorded_at     timestamptz not null default now(),
  constraint cfb_sp_run_id_format check (run_id ~ '^cfbsr_[0-9a-f]{24}$'),
  constraint cfb_sp_run_status check (status in ('OK','UNCHANGED','FAILED')),
  constraint cfb_sp_run_order check (finished_at >= started_at),
  constraint cfb_sp_run_snapshot check ((status = 'OK') = (snapshot_id is not null)),
  constraint cfb_sp_run_reason check (status = 'OK' or coalesce(length(reason), 0) > 0)
);
comment on table public.cfb_sp_sync_runs is
  'Every SP+ sync attempt (football/sp_plus/sync.js): OK, UNCHANGED (the source had not updated) or FAILED, with the unmapped team names. Append-only; service role only.';

create index if not exists cfb_sp_ratings_week_idx on public.cfb_sp_ratings (season, week_key, captured_at desc);
create index if not exists cfb_sp_ratings_team_idx on public.cfb_sp_ratings (team_id, captured_at desc);

create or replace function public.cfb_sp_append_only()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $fn$
begin
  if tg_op = 'UPDATE' then
    raise exception '% is append-only: rows are never updated (a revised rating is a new capture)', tg_table_name
      using errcode = 'restrict_violation';
  elsif tg_op = 'DELETE' then
    raise exception '% is append-only: rows are never deleted', tg_table_name
      using errcode = 'restrict_violation';
  else
    raise exception '% is append-only: it is never truncated', tg_table_name
      using errcode = 'restrict_violation';
  end if;
end $fn$;

-- Append-only triggers, row level security with no policy, and the grants.
-- anon and authenticated get nothing; the service role inserts and reads
-- (and cannot update, delete or truncate even before the triggers).
do $blk$
declare
  t text;
begin
  foreach t in array array['cfb_sp_ratings','cfb_sp_sync_runs']
  loop
    execute format('drop trigger if exists %I on public.%I', t || '_no_update_trg', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.cfb_sp_append_only()', t || '_no_update_trg', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_delete_trg', t);
    execute format('create trigger %I before delete on public.%I for each row execute function public.cfb_sp_append_only()', t || '_no_delete_trg', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate_trg', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.cfb_sp_append_only()', t || '_no_truncate_trg', t);

    execute format('alter table public.%I enable row level security', t);

    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on table public.%I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on table public.%I from authenticated', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke update, delete, truncate on table public.%I from service_role', t);
      execute format('grant select, insert on table public.%I to service_role', t);
    end if;
  end loop;
end $blk$;

-- ================================================================ the registry
-- External estimates (football/sp_plus/registry.json): a third party's model
-- is registered with its source, version and terms, and the server refuses to
-- record one as an EdgeDesk model or as validated by EdgeDesk. Public
-- metadata (no rating): anon and authenticated may read it; append-only like
-- the rest.
create table if not exists public.cfb_external_estimates (
  estimate_id            text primary key,
  name                   text not null,
  kind                   text not null,
  sport                  text not null,
  edgedesk_model         boolean not null default false,
  validated_by_edgedesk  boolean not null default false,
  rating_tier            text not null,
  line_tier              text,
  model_key              text,
  rule                   text,
  source                 text not null,
  provider               text not null,
  source_version         text not null,
  terms_url              text not null,
  terms_dated            date,
  terms_summary          text not null,
  attribution            text not null,
  registered_at          timestamptz not null,
  recorded_at            timestamptz not null default now(),
  constraint cfb_ext_kind check (kind = 'EXTERNAL_ESTIMATE'),
  constraint cfb_ext_not_edgedesk check (edgedesk_model = false and validated_by_edgedesk = false),
  constraint cfb_ext_rating_tier check (rating_tier = 'T3'),
  constraint cfb_ext_line_tier check (line_tier is null or line_tier = 'T2'),
  constraint cfb_ext_attribution check (length(attribution) > 0)
);
comment on table public.cfb_external_estimates is
  'External estimates (football/sp_plus/registry.json): third-party models shown beside EdgeDesk''s numbers. Never an EdgeDesk model, never validated by EdgeDesk (check constraint). Append-only; public metadata.';

insert into public.cfb_external_estimates (estimate_id, name, kind, sport, edgedesk_model, validated_by_edgedesk, rating_tier, line_tier,
  model_key, rule, source, provider, source_version, terms_url, terms_dated, terms_summary, attribution, registered_at)
values ('cfbd.sp_plus_projected_line', 'SP+ projected line', 'EXTERNAL_ESTIMATE', 'cfb', false, false, 'T3', 'T2',
  'cfbd.sp_plus', 'cfb_sp_projection_v1',
  'SP+, ESPN''s opponent-adjusted efficiency rating, created by Bill Connelly',
  'CollegeFootballData.com (GET /ratings/sp?year=<season>)',
  'per capture: cfbd-ratings-sp:<season>:<payload sha256 prefix> (public.cfb_sp_ratings.source_version)',
  'https://collegefootballdata.com/terms', date '2026-08-12',
  'CFBD: commercial use allowed (3); reasonable portions of factual data in a larger product (4); no public mirror or bulk download (5); key server-side (2); attribution recommended (6). SP+ is ESPN''s: no licence found or obtained; the owner chose (2026-10-29) to show the derived projected line only, with attribution, never a raw rating.',
  'Projection derived from SP+ (ESPN, Bill Connelly). Data provided by CollegeFootballData.com.',
  timestamptz '2026-10-29 00:00:00+00')
on conflict (estimate_id) do nothing;

drop trigger if exists cfb_external_estimates_no_update_trg on public.cfb_external_estimates;
create trigger cfb_external_estimates_no_update_trg before update on public.cfb_external_estimates for each row execute function public.cfb_sp_append_only();
drop trigger if exists cfb_external_estimates_no_delete_trg on public.cfb_external_estimates;
create trigger cfb_external_estimates_no_delete_trg before delete on public.cfb_external_estimates for each row execute function public.cfb_sp_append_only();
drop trigger if exists cfb_external_estimates_no_truncate_trg on public.cfb_external_estimates;
create trigger cfb_external_estimates_no_truncate_trg before truncate on public.cfb_external_estimates for each statement execute function public.cfb_sp_append_only();

alter table public.cfb_external_estimates enable row level security;
drop policy if exists cfb_external_estimates_read on public.cfb_external_estimates;
create policy cfb_external_estimates_read on public.cfb_external_estimates for select to public using (true);
do $blk$
begin
  revoke all on table public.cfb_external_estimates from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table public.cfb_external_estimates from anon;
    grant select on table public.cfb_external_estimates to anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table public.cfb_external_estimates from authenticated;
    grant select on table public.cfb_external_estimates to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke update, delete, truncate on table public.cfb_external_estimates from service_role;
    grant select, insert on table public.cfb_external_estimates to service_role;
  end if;
end $blk$;
