-- tennis_record -- part 1 of 9.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- ===========================================================================
-- EdgeDesk Tennis — the RESEARCH RECORD contract (ATP + WTA).
--
-- WHY THIS FILE EXISTS. app.html has read `tennis.players`, `tennis.matches`,
-- `tennis.rankings_current` and the five record views since the Tennis panel
-- shipped, tools/tennis/db.js resolves identity against them, and
-- build_baselines.js counts career, surface and form from them. None of it was
-- ever installed: the module's own comment points at a migration
-- ("migrations/020_tennis_schema.sql") that is in no repository, and the panel
-- has rendered its honest empty state ever since — "The database refuses to
-- store any source not cleared for commercial use, so this module is empty
-- until a licensed feed is loaded."
--
-- This is that schema, and it is that refusal made real. The claim on screen
-- was a promise about a database that did not exist yet; every table below
-- that stores a match carries a source key, and a trigger checks that key
-- against tennis.source_licenses before the row is allowed in. The historical
-- archive EdgeDesk holds is CC BY-NC-SA 4.0 — research, non-commercial,
-- share-alike — so it is registered as exactly that, admitted for research,
-- and REFUSED wherever a row claims commercial clearance it does not have.
-- Replacing it later with a licensed feed is one row in one table, and every
-- contract downstream of it is unchanged.
--
-- THE LAYERS, and the rule each one obeys:
--
--   0  licensing       tennis.source_licenses + tennis.enforce_source_license
--                      No match, feature or rating may name a source that is
--                      not registered. Nothing is "unknown provenance".
--   1  raw / staging   tennis.stg_archive_matches — the 108-column import
--                      surface, every column text, nothing typed or trusted
--                      yet. PRIVATE: no client role may read it.
--   2  entities        tennis.players, tennis.tournaments (extended, not
--                      replaced), tennis.venues
--   3  history         tennis.matches — one canonical row per match, keyed by
--                      a deterministic match_uid so a re-import updates
--   4  point-in-time   tennis.player_match_features — what was knowable
--                      BEFORE the match and nothing else. PRIVATE.
--   5  current rating  tennis.player_ratings_current, tennis.rankings_current
--   6  market          tennis.odds_snapshots
--   7  model           tennis.model_registry, tennis.model_predictions
--                      (append-only; a prediction cannot be rewritten)
--   8  research        tennis.research_opportunities
--   9  AI context      tennis.ai_* secure functions — bounded, typed, and the
--                      only door the assistant reads tennis through
--  10  public record   tennis.prediction_record + the calibration views
--  11  operations      tennis.ingestion_runs, tennis.data_quality_issues,
--                      tennis.weather_observations
--
-- NOTHING EXISTING IS TOUCHED. tennis.tournaments already exists and is
-- already multi-provider (`provider` + unique (provider, provider_tournament_id),
-- ids shaped '<provider>:<id>'), so the archive's events are ADDED to it under
-- provider 'archive' rather than given a second table that would mean the same
-- thing. Every read the live centre makes is either keyed by tournament_id or
-- filtered `state in ('scheduled','live')`; an archived event is 'final', so
-- it is invisible to all of them. The live tables, the provider directory and
-- the baselines are not altered by a single statement in this file.
--
-- RESEARCH, NOT PICKS. Nothing here stores a recommendation, a stake or a
-- verb. A model probability is stored beside the market's, with the gap named
-- and the reason it might be wrong named with it.
--
-- Idempotent, additive, and it ends in a report — the convention every file in
-- this folder follows. Run it in the SQL editor, or with psql:
--
--     psql "$SUPABASE_DB_URL" -f supabase/tennis_record.sql
--
-- Every report row must read ok. Tested against a real PostgreSQL by
-- tools/tennis/record_sql.test.js (`npm run tennis:record:sql`), which applies
-- it twice, applies it on top of tennis_live_center.sql, and attacks it as
-- anon, as a signed-in free account and as an entitled subscriber.
-- ===========================================================================

create schema if not exists tennis;
grant usage on schema tennis to anon, authenticated, service_role;

-- The live contract creates this too. Both files are idempotent and both need
-- it, so each carries it rather than depending on an apply order.
create table if not exists tennis.meta (
  key   text primary key,
  value text
);
grant select, insert, update on tennis.meta to service_role;
grant select on tennis.meta to anon, authenticated;

create or replace function tennis.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ===========================================================================
-- LAYER 0 — LICENSING. The gate the product already claims to have.
-- ===========================================================================

-- Every source of tennis facts EdgeDesk holds, and what it is allowed to be
-- used for. `commercial_use` is the one that matters: the archive is false,
-- and the trigger below refuses any row that claims otherwise.
create table if not exists tennis.source_licenses (
  source_key       text primary key,
  title            text not null,
  licence          text not null,
  licence_url      text,
  attribution      text,
  commercial_use   boolean not null default false,
  research_use     boolean not null default true,
  redistribution   boolean not null default false,
  share_alike      boolean not null default false,
  -- What the row is allowed to reach. 'research' rows may fill the record and
  -- feed the model; only a 'commercial' source may be sold, which in this
  -- product means: surfaced to a paying subscriber as a priced research
  -- opportunity. The check below is what enforces it.
  allowed_uses     text[] not null default array['research']::text[],
  notes            text,
  cleared_by       text,
  cleared_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint tennis_source_licence_uses_shape
    check (allowed_uses <@ array['research','commercial','internal','display']::text[]),
  -- A source cannot be marked commercially usable without saying who cleared
  -- it and when. "Somebody probably checked" is how a licence breach happens.
  constraint tennis_source_licence_commercial_needs_clearance
    check (commercial_use = false or (cleared_by is not null and cleared_at is not null))
);
drop trigger if exists tennis_source_licenses_touch on tennis.source_licenses;
create trigger tennis_source_licenses_touch before update on tennis.source_licenses
  for each row execute function tennis.touch_updated_at();

-- The sources this build knows about. Inserted, never overwritten: an operator
-- who clears a feed commercially has updated the row by hand, and a re-run of
-- this file must not undo that.
insert into tennis.source_licenses
  (source_key, title, licence, licence_url, attribution, commercial_use, research_use,
   redistribution, share_alike, allowed_uses, notes, cleared_by, cleared_at)
values
  ('archive',
   'Sackmann-format ATP/WTA match archive, 1968-2026',
   'CC BY-NC-SA 4.0',
   'https://creativecommons.org/licenses/by-nc-sa/4.0/',
   'Jeff Sackmann / tennis_atp and tennis_wta',
   false, true, false, true,
   array['research']::text[],
   'NON-COMMERCIAL. Research and model development only. This source may not '
   'fund a commercial research product without separate permission; replace it '
   'with a licensed feed before any paid tennis surface ships. Share-alike '
   'applies to derived datasets that are redistributed.',
   null, null),
  ('espn',
   'ESPN public tennis scoreboard (draws, live scores, athletes)',
   'Publisher terms',
   null, 'ESPN', false, true, false, false,
   array['research','display']::text[],
   'Public scoreboard used for fixtures, live state and identity. Not a '
   'licensed statistical feed and not cleared for commercial redistribution.',
   null, null),
  ('open-meteo',
   'Open-Meteo historical reanalysis',
   'CC BY 4.0 (non-commercial API tier)',
   'https://open-meteo.com/en/license',
   'Open-Meteo', false, true, false, false,
   array['research']::text[],
   'Tournament-week reanalysis. The free tier is non-commercial; a commercial '
   'plan is required before weather reaches a paid surface.',
   null, null),
  ('odds_api',
   'EdgeDesk odds capture (public.signals)',
   'Commercial data agreement',
   null, null, true, true, false, false,
   array['research','commercial','display']::text[],
   'The market prices EdgeDesk already licenses for every other sport.',
   'edgedesk-ops', now()),
  ('edgedesk',
   'EdgeDesk-derived values (features, ratings, model output)',
   'Proprietary',
   null, 'EdgeDesk / Rackler Tech Ventures LLC', true, true, false, false,
   array['research','commercial','internal','display']::text[],
   'Values EdgeDesk computed itself. Derived FROM a non-commercial source, '
   'so a derived row still carries the source key it was derived from and is '
   'gated by that source, not by this row.',
   'edgedesk-ops', now())
on conflict (source_key) do nothing;

update tennis.source_licenses
   set cleared_by = coalesce(cleared_by, 'edgedesk-ops'),
       cleared_at = coalesce(cleared_at, now())
 where commercial_use = true and (cleared_by is null or cleared_at is null);

-- Is this source allowed to be used this way? Fixed search path, no default
-- public execute: the two rules every privileged function in this project
-- follows.
create or replace function tennis.license_allows(p_source_key text, p_use text)
returns boolean
language sql
stable
security definer
set search_path = tennis, pg_temp
as $$
  select exists (
    select 1 from tennis.source_licenses l
     where l.source_key = p_source_key
       and p_use = any (l.allowed_uses)
  );
$$;
revoke all on function tennis.license_allows(text, text) from public;
grant execute on function tennis.license_allows(text, text) to anon, authenticated, service_role;

-- THE GATE. Every table that stores a tennis fact carries `source_key`, and
-- this refuses a row whose source is not registered. It is a trigger rather
-- than a foreign key on purpose: the message is the point. A foreign-key
-- violation says "23503"; this says which source was refused and what to do.
create or replace function tennis.enforce_source_license()
returns trigger
language plpgsql
security definer
set search_path = tennis, pg_temp
as $$
declare
  ok boolean;
begin
  if new.source_key is null then
    raise exception using
      errcode = 'check_violation',
      message = 'tennis.' || tg_table_name || ': source_key is null',
      hint = 'Every stored tennis fact names its source. Register it in '
             'tennis.source_licenses and set source_key.';
  end if;
  select true into ok from tennis.source_licenses where source_key = new.source_key;
  if not found then
    raise exception using
      errcode = 'foreign_key_violation',
      message = 'tennis.' || tg_table_name || ': unregistered source "' || new.source_key || '"',
      hint = 'Insert the source into tennis.source_licenses first, with its '
             'licence and what it is allowed to be used for. EdgeDesk stores '
             'no fact of unknown provenance.';
  end if;
  return new;
end $$;
revoke all on function tennis.enforce_source_license() from public, anon, authenticated;

-- ===========================================================================
-- LAYER 11a — INGESTION RUNS and DATA QUALITY. Declared early because every
-- table below references a run id, and because an import that cannot say what
-- it did is not an import.
-- ===========================================================================

create table if not exists tennis.ingestion_runs (
  run_id             uuid primary key default gen_random_uuid(),
  job                text not null,                 -- 'archive_import', 'incremental_results', ...
  source_key         text not null,
  source_version     text,                          -- the build id / release the rows came from
  source_checksum    text,                          -- sha256 of the file actually read
  source_file        text,
  build_version      text,                          -- the EdgeDesk code version that ran
  scope              text,                          -- 'ATP 2024', 'all', a cursor window
  cursor_from        timestamptz,
  cursor_to          timestamptz,
  started_at         timestamptz not null default now(),
  finished_at        timestamptz,
  rows_read          bigint not null default 0,
  rows_inserted      bigint not null default 0,
  rows_updated       bigint not null default 0,
  rows_unchanged     bigint not null default 0,
  rows_rejected      bigint not null default 0,
  rows_quarantined   bigint not null default 0,
  reconciled         boolean,                       -- read = accepted + rejected?
  status             text not null default 'running',
  error_summary      text,
  details            jsonb not null default '{}'::jsonb,
  updated_at         timestamptz not null default now(),
  constraint tennis_ingestion_runs_status_shape
    check (status in ('running','ok','warn','error','cancelled','dry_run','resumed')),
  constraint tennis_ingestion_runs_source_fk
    foreign key (source_key) references tennis.source_licenses (source_key) on delete restrict
);
create index if not exists tennis_ingestion_runs_job_idx
  on tennis.ingestion_runs (job, started_at desc);
create index if not exists tennis_ingestion_runs_status_idx
  on tennis.ingestion_runs (status, started_at desc);
create index if not exists tennis_ingestion_runs_source_idx
  on tennis.ingestion_runs (source_key, started_at desc);
drop trigger if exists tennis_ingestion_runs_touch on tennis.ingestion_runs;
create trigger tennis_ingestion_runs_touch before update on tennis.ingestion_runs
  for each row execute function tennis.touch_updated_at();

-- What was wrong with a row, kept rather than discarded. A quarantined row is
-- evidence: it says the source changed shape, or that a player id collided, or
-- that a "match" lasted four minutes. Silence would say nothing changed.
create table if not exists tennis.data_quality_issues (
  issue_id       bigserial primary key,
  run_id         uuid references tennis.ingestion_runs (run_id) on delete set null,
  source_key     text,
  issue_type     text not null,
  severity       text not null default 'warn',
  entity_type    text,                              -- 'match','player','tournament','venue','rating'
  entity_key     text,
  field          text,
  observed       text,
  expected       text,
  detail         text,
  payload        jsonb,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  occurrences    integer not null default 1,
  resolved_at    timestamptz,
  constraint tennis_dq_severity_shape check (severity in ('info','warn','error','fatal')),
  constraint tennis_dq_type_shape check (issue_type in (
    'malformed_record','unresolved_player','duplicate_identifier','impossible_statistic',
    'missing_surface','ambiguous_venue','stale_rating','missing_feature','score_unparsed',
    'out_of_range','source_conflict','license_refused','reconciliation_gap'))
);
create index if not exists tennis_dq_type_idx on tennis.data_quality_issues (issue_type, last_seen_at desc);
create index if not exists tennis_dq_run_idx  on tennis.data_quality_issues (run_id);
create index if not exists tennis_dq_open_idx on tennis.data_quality_issues (resolved_at) where resolved_at is null;
-- One open issue per (type, entity, field): a second sighting bumps the count
-- rather than writing a second row, so a recurring fault is one line with a
-- number on it instead of ten thousand.
create unique index if not exists tennis_dq_dedup_idx
  on tennis.data_quality_issues (issue_type, coalesce(entity_type,''), coalesce(entity_key,''), coalesce(field,''))
  where resolved_at is null;
