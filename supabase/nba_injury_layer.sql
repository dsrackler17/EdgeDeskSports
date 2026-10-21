-- =============================================================================
-- nba_injury_layer.sql — the NBA roster and injury layer (T0), the player
-- impact snapshots (T2) and the Roster-Adjusted Projection snapshots (T3,
-- EXPERIMENTAL). README §NBA roster and injury layer.
--
-- WHO WRITES. Only supabase/functions/nba_injury_sync (service_role). Every
-- table here is APPEND-ONLY: an update, a delete or a truncate is refused by a
-- trigger, so a report, a roster, a projection or a run, once written, is the
-- record. Readers (anon, authenticated) may select; no client may write.
--
--   nba_injury_sync_runs          one row per run (ok / warn / error / skipped)
--   nba_injury_alerts             FAILURE / DEGRADED / DRIFT / WARNING, by run
--   nba_roster_captures           one per team per changed roster (ESPN; the
--                                 hoopR copy is the fallback)
--   nba_roster_snapshots          one row per player per capture
--   nba_injury_reports            one per distinct report (identical
--                                 consecutive reports are not stored twice)
--   nba_injury_report_snapshots   one row per player per report
--   nba_player_impact_snapshots   the RAPM impact and minutes the model read
--   nba_adjusted_projection_snapshots  every adjusted projection, with the
--                                 model version and the report it used
--
--   nba_player_status_current     the latest status per player per upcoming game
--   nba_roster_current            the latest capture per team
--   nba_roster_changes            who joined or left between captures
--   nba_adjusted_projection_current  the latest projection per upcoming game
--   nba_injury_readiness          the KPIs (freshness, unmatched names,
--                                 missing teams, failures, degradation, drift)
--   nba_injury_meta               the same as {job}_last_run rows for the
--                                 research module's pipeline ledger
--   nba_injury_card(...)          what one game card shows, with the
--                                 freshness rule applied in one place
--
-- THE MODEL VERSION LINK. A projection names model_key, model_version and
-- model_version_ref (the research_model_versions row, as text because the
-- registry's DDL lives only in the database). A trigger refuses a projection
-- whose version is not the one supabase/nba_roster_adjusted_registry.sql
-- registered (public.nba_injury_config), so nothing unregistered is stored.
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

begin;

-- ---------------------------------------------------------------- the guard
create or replace function public.nba_injury_keep()
returns trigger language plpgsql as $k$
begin
  raise exception 'public.% is append-only: % refused (write a new row instead)', tg_table_name, tg_op;
end $k$;

-- ---------------------------------------------------------------- config (operator-set; the registry file sets the model version)
create table if not exists public.nba_injury_config (
  key        text primary key,
  value      text not null,
  note       text,
  updated_at timestamptz not null default now()
);
insert into public.nba_injury_config (key, value, note) values
  ('check_max_age_minutes', '75', 'game-day checks run every 30 minutes; a check older than this (with no skipped run after it) is stale'),
  ('offday_max_age_hours', '26', 'outside the game-day window the sync checks once a day'),
  ('official_report_max_age_minutes', '120', 'on a game day, an official report older than this is a DEGRADED KPI')
on conflict (key) do nothing;

-- ---------------------------------------------------------------- runs and alerts
create table if not exists public.nba_injury_sync_runs (
  run_id               uuid primary key default gen_random_uuid(),
  build                text,
  trigger              text not null default 'cron' check (trigger in ('cron', 'manual', 'test')),
  status               text not null check (status in ('ok', 'warn', 'error', 'skipped')),
  skipped_reason       text,
  started_at           timestamptz not null,
  finished_at          timestamptz not null default now(),
  et_date              date,
  game_day             boolean,
  report_id            bigint,
  report_source        text check (report_source in ('nba_official', 'espn_injuries')),
  report_changed       boolean,
  report_published_at  timestamptz,
  report_url           text,
  official_ok          boolean,
  fallback_used        boolean,
  rosters_checked      integer,
  rosters_changed      integer,
  roster_failures      text[],
  rows_read            integer,
  unmatched            integer,
  unread_lines         integer,
  teams_playing        text[],
  teams_missing        text[],
  teams_not_submitted  text[],
  projections_written  integer,
  projections_withheld integer,
  projections_unchanged integer,
  inputs_generated_at  timestamptz,
  simulated            boolean not null default false,
  message              text,
  details              jsonb not null default '{}'::jsonb,
  check (finished_at >= started_at)
);
create index if not exists nba_injury_sync_runs_finished_idx on public.nba_injury_sync_runs (finished_at desc);

create table if not exists public.nba_injury_alerts (
  id         bigserial primary key,
  run_id     uuid references public.nba_injury_sync_runs (run_id),
  severity   text not null check (severity in ('FAILURE', 'DEGRADED', 'DRIFT', 'WARNING')),
  code       text not null,
  message    text not null,
  detail     jsonb,
  created_at timestamptz not null default now()
);
create index if not exists nba_injury_alerts_created_idx on public.nba_injury_alerts (created_at desc);

-- ---------------------------------------------------------------- rosters (T0)
create table if not exists public.nba_roster_captures (
  id            bigserial primary key,
  team_id       text not null,
  team_abbr     text not null,
  source        text not null check (source in ('espn_roster', 'hoopr_rosters')),
  source_url    text,
  captured_at   timestamptz not null,
  content_hash  text not null,
  player_count  integer not null check (player_count >= 0),
  run_id        uuid,  -- the run that wrote it (no foreign key: the run row is written last, in its own request)
  created_at    timestamptz not null default now()
);
create index if not exists nba_roster_captures_team_idx on public.nba_roster_captures (team_id, captured_at desc, id desc);

create table if not exists public.nba_roster_snapshots (
  id             bigserial primary key,
  capture_id     bigint not null references public.nba_roster_captures (id),
  team_id        text not null,
  team_abbr      text not null,
  player_id      text not null,
  player_name    text not null,
  position       text,
  jersey         text,
  roster_status  text not null check (roster_status in ('ACTIVE', 'TWO_WAY', 'INACTIVE', 'SUSPENDED', 'OTHER')),
  source_status  text,
  source         text not null,
  captured_at    timestamptz not null,
  unique (capture_id, player_id)
);
create index if not exists nba_roster_snapshots_player_idx on public.nba_roster_snapshots (player_id, captured_at desc);

-- ---------------------------------------------------------------- injury reports (T0)
create table if not exists public.nba_injury_reports (
  id                   bigserial primary key,
  source               text not null check (source in ('nba_official', 'espn_injuries')),
  source_url           text,
  report_published_at  timestamptz,
  captured_at          timestamptz not null,
  content_hash         text not null,
  parser_version       text not null,
  rows_count           integer not null check (rows_count >= 0),
  unmatched            integer not null default 0,
  unread_lines         integer not null default 0,
  matchups             jsonb not null default '[]'::jsonb,   -- [{game_id, game_date, matchup, away_id, home_id, game_start_utc}]: the games this report covers
  not_submitted        jsonb not null default '[]'::jsonb,   -- [{game_id, matchup, team_id}]: teams that had not filed
  unread               jsonb not null default '[]'::jsonb,   -- every line that did not read, kept
  pdf_sha256           text,
  run_id               uuid,  -- the run that wrote it (no foreign key: the run row is written last, in its own request)
  created_at           timestamptz not null default now(),
  check (source <> 'nba_official' or report_published_at is not null),
  check (jsonb_typeof(matchups) = 'array' and jsonb_typeof(not_submitted) = 'array')
);
create index if not exists nba_injury_reports_captured_idx on public.nba_injury_reports (captured_at desc, id desc);

create table if not exists public.nba_injury_report_snapshots (
  id                   bigserial primary key,
  report_id            bigint not null references public.nba_injury_reports (id),
  game_id              text,
  game_date            date,
  game_start_utc       timestamptz,
  matchup              text,
  team_id              text not null,
  team_abbr            text not null,
  player_id            text,
  player_name          text not null,
  player_raw           text,
  match_method         text not null check (match_method in ('team_exact', 'team_initial', 'league_exact', 'espn_id', 'ambiguous', 'unmatched')),
  team_mismatch        boolean not null default false,
  status               text not null check (status in ('OUT', 'DOUBTFUL', 'QUESTIONABLE', 'PROBABLE', 'AVAILABLE', 'UNKNOWN')),
  source_status        text,
  reason               text,
  report_published_at  timestamptz,
  captured_at          timestamptz not null,
  source               text not null,
  check ((player_id is null) = (match_method in ('ambiguous', 'unmatched')))
);
create index if not exists nba_injury_report_snapshots_report_idx on public.nba_injury_report_snapshots (report_id);
create index if not exists nba_injury_report_snapshots_game_idx on public.nba_injury_report_snapshots (game_id, report_id);

-- ---------------------------------------------------------------- player impact (T2, EdgeDesk's own)
create table if not exists public.nba_player_impact_snapshots (
  id                   bigserial primary key,
  measure              text not null,
  tier                 text not null check (tier in ('T1', 'T2')),
  formula              text not null,
  source_url           text,
  inputs_generated_at  timestamptz not null,
  content_hash         text not null unique,
  player_count         integer not null,
  preseason_games      integer not null default 0,
  players              jsonb not null,
  created_at           timestamptz not null default now()
);

-- ---------------------------------------------------------------- the Roster-Adjusted Projection (T3, EXPERIMENTAL)
create table if not exists public.nba_adjusted_projection_snapshots (
  id                      bigserial primary key,
  game_id                 text not null,
  game_start_utc          timestamptz not null,
  home_id                 text not null,
  away_id                 text not null,
  home_abbr               text,
  away_abbr               text,
  model_key               text not null,
  model_version           text not null,
  model_version_ref       text not null,
  injury_report_id        bigint not null references public.nba_injury_reports (id),
  report_source           text not null check (report_source in ('nba_official', 'espn_injuries')),
  home_roster_capture_id  bigint references public.nba_roster_captures (id),
  away_roster_capture_id  bigint references public.nba_roster_captures (id),
  impact_snapshot_id      bigint references public.nba_player_impact_snapshots (id),
  slate_generated_at      timestamptz not null,
  status                  text not null check (status in ('OK', 'WITHHELD')),
  reasons                 jsonb not null default '[]'::jsonb,
  baseline                jsonb not null,
  adjusted                jsonb,
  delta                   jsonb,
  adjustments             jsonb not null default '[]'::jsonb,
  roster_changes          jsonb,
  minutes                 jsonb,
  inputs_hash             text not null,
  core_version            text not null,
  run_id                  uuid,  -- the run that wrote it (no foreign key: the run row is written last, in its own request)
  computed_at             timestamptz not null default now(),
  check (computed_at < game_start_utc),
  check ((status = 'OK') = (adjusted is not null)),
  check (status = 'OK' or jsonb_array_length(reasons) > 0)
);
create index if not exists nba_adjusted_projection_game_idx on public.nba_adjusted_projection_snapshots (game_id, computed_at desc, id desc);

-- a projection must name the registered model version (nba_roster_adjusted_registry.sql writes it)
create or replace function public.nba_adjusted_projection_registered()
returns trigger language plpgsql as $r$
declare k text; v text; ref text;
begin
  select value into k from public.nba_injury_config where key = 'roster_model_key';
  select value into v from public.nba_injury_config where key = 'roster_model_version';
  select value into ref from public.nba_injury_config where key = 'roster_model_version_ref';
  if ref is null then
    raise exception 'the Roster-Adjusted Projection is not registered (apply supabase/nba_roster_adjusted_registry.sql): nothing unregistered is stored';
  end if;
  if new.model_key is distinct from k or new.model_version is distinct from v or new.model_version_ref is distinct from ref then
    raise exception 'projection names %/% (%) but the registered version is %/% (%)', new.model_key, new.model_version, new.model_version_ref, k, v, ref;
  end if;
  return new;
end $r$;
drop trigger if exists nba_adjusted_projection_registered on public.nba_adjusted_projection_snapshots;
create trigger nba_adjusted_projection_registered before insert on public.nba_adjusted_projection_snapshots for each row execute function public.nba_adjusted_projection_registered();

-- append-only, every table
do $t$ declare t text; begin
  foreach t in array array['nba_injury_sync_runs', 'nba_injury_alerts', 'nba_roster_captures', 'nba_roster_snapshots', 'nba_injury_reports',
                           'nba_injury_report_snapshots', 'nba_player_impact_snapshots', 'nba_adjusted_projection_snapshots'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_frozen', t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.nba_injury_keep()', t || '_frozen', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.nba_injury_keep()', t || '_no_truncate', t);
  end loop;
end $t$;

-- ---------------------------------------------------------------- views
create or replace view public.nba_roster_current with (security_invoker = true) as
select s.team_id, s.team_abbr, s.player_id, s.player_name, s.position, s.jersey, s.roster_status, s.source_status, s.source, s.captured_at, s.capture_id
  from public.nba_roster_snapshots s
  join (select distinct on (team_id) id from public.nba_roster_captures order by team_id, captured_at desc, id desc) c on c.id = s.capture_id;

create or replace view public.nba_roster_changes with (security_invoker = true) as
with caps as (
  select id, team_id, team_abbr, captured_at, source, lag(id) over (partition by team_id order by captured_at, id) as prev_id
    from public.nba_roster_captures
)
select c.team_id, c.team_abbr, c.id as capture_id, c.captured_at, c.source, 'ADDED'::text as change, s.player_id, s.player_name
  from caps c join public.nba_roster_snapshots s on s.capture_id = c.id
 where c.prev_id is not null and not exists (select 1 from public.nba_roster_snapshots p where p.capture_id = c.prev_id and p.player_id = s.player_id)
union all
select c.team_id, c.team_abbr, c.id, c.captured_at, c.source, 'REMOVED', p.player_id, p.player_name
  from caps c join public.nba_roster_snapshots p on p.capture_id = c.prev_id
 where not exists (select 1 from public.nba_roster_snapshots s where s.capture_id = c.id and s.player_id = p.player_id);

-- the latest report that covers each upcoming game, and its rows for that game
create or replace view public.nba_player_status_current with (security_invoker = true) as
with cover as (
  select p.id as report_id, m ->> 'game_id' as game_id, (m ->> 'game_start_utc')::timestamptz as game_start_utc, p.captured_at
    from public.nba_injury_reports p cross join lateral jsonb_array_elements(p.matchups) m
   where m ->> 'game_id' is not null
), latest as (
  select distinct on (game_id) game_id, report_id, game_start_utc from cover order by game_id, captured_at desc, report_id desc
)
select r.game_id, l.game_start_utc, r.team_id, r.team_abbr, r.player_id, r.player_name, r.status, r.source_status, r.reason, r.match_method, r.team_mismatch,
       r.report_id, p.source as report_source, p.report_published_at, p.captured_at, p.source_url
  from latest l
  join public.nba_injury_report_snapshots r on r.report_id = l.report_id and r.game_id = l.game_id
  join public.nba_injury_reports p on p.id = l.report_id
 where l.game_start_utc > now() - interval '3 hours';

create or replace view public.nba_adjusted_projection_current with (security_invoker = true) as
select distinct on (game_id) *
  from public.nba_adjusted_projection_snapshots
 where game_start_utc > now() - interval '3 hours'
 order by game_id, computed_at desc, id desc;

-- THE KPIs: freshness, data quality, failures, degradation, drift. One row.
create or replace view public.nba_injury_readiness with (security_invoker = true) as
with any_run as (select * from public.nba_injury_sync_runs order by finished_at desc limit 1),
     checked as (select * from public.nba_injury_sync_runs where status <> 'skipped' order by finished_at desc limit 1),
     good as (select * from public.nba_injury_sync_runs where status in ('ok', 'warn') order by finished_at desc limit 1),
     official as (select max(report_published_at) as at from public.nba_injury_sync_runs where official_ok and status in ('ok', 'warn')),
     a24 as (select count(*) filter (where severity = 'FAILURE') as failures, count(*) filter (where severity = 'DEGRADED') as degraded,
                    count(*) filter (where severity = 'DRIFT') as drift, count(*) filter (where severity = 'WARNING') as warnings
               from public.nba_injury_alerts where created_at > now() - interval '24 hours'),
     r24 as (select count(*) as runs, count(*) filter (where status = 'error') as errors, count(*) filter (where status = 'skipped') as skipped
               from public.nba_injury_sync_runs where finished_at > now() - interval '24 hours'),
     streak as (select count(*) as n from public.nba_injury_sync_runs
                 where status = 'error' and finished_at > coalesce((select finished_at from good), '-infinity'::timestamptz)),
     rost as (select count(*) as teams, min(captured_at) as oldest, max(captured_at) as newest
                from (select distinct on (team_id) team_id, captured_at from public.nba_roster_captures order by team_id, captured_at desc, id desc) x),
     proj as (select count(*) filter (where status = 'OK') as ok, count(*) filter (where status = 'WITHHELD') as withheld
                from public.nba_adjusted_projection_current where game_start_utc > now()),
     cfg as (select coalesce((select value::int from public.nba_injury_config where key = 'official_report_max_age_minutes'), 120) as off_max)
select
  (select finished_at from any_run)                                         as last_run_at,
  (select status from any_run)                                              as last_run_status,
  (select finished_at from checked)                                         as last_check_at,
  (select status from checked)                                              as last_check_status,
  (select message from checked)                                             as last_check_message,
  (select finished_at from good)                                            as last_success_at,
  round(extract(epoch from now() - (select finished_at from good)) / 60)::int as minutes_since_success,
  (select game_day from any_run)                                            as game_day,
  (select report_source from good)                                          as report_source,
  coalesce((select fallback_used from good), false)                         as fallback_in_use,
  (select at from official)                                                 as last_official_report_at,
  round(extract(epoch from now() - (select at from official)) / 60)::int    as minutes_since_official_report,
  coalesce((select unmatched from good), 0)                                 as unmatched_players,
  coalesce((select unread_lines from good), 0)                              as unread_lines,
  coalesce((select teams_missing from good), '{}')                          as teams_missing,
  coalesce(array_length((select teams_missing from good), 1), 0)            as teams_missing_count,
  coalesce((select teams_not_submitted from good), '{}')                    as teams_not_submitted,
  (select n from streak)::int                                               as consecutive_failures,
  (select failures from a24)::int as failures_24h, (select degraded from a24)::int as degraded_24h,
  (select drift from a24)::int as drift_24h, (select warnings from a24)::int as warnings_24h,
  (select runs from r24)::int as runs_24h, (select errors from r24)::int as errors_24h, (select skipped from r24)::int as skipped_24h,
  (select teams from rost)::int as teams_with_roster, (select oldest from rost) as oldest_roster_capture_at, (select newest from rost) as newest_roster_capture_at,
  (select ok from proj)::int as projections_ok, (select withheld from proj)::int as projections_withheld,
  case
    when (select finished_at from any_run) is null then 'error'
    when (select status from checked) = 'error' then 'error'
    when now() - (select finished_at from any_run) > interval '90 minutes' then 'error'
    when (select failures from a24) > 0 or (select degraded from a24) > 0 or (select drift from a24) > 0
      or coalesce((select fallback_used from good), false)
      or coalesce((select unmatched from good), 0) > 0
      or coalesce(array_length((select teams_missing from good), 1), 0) > 0
      or ((select game_day from any_run) and (now() - (select at from official)) > make_interval(mins => (select off_max from cfg))) then 'warn'
    else 'ok'
  end as state,
  case
    when (select finished_at from any_run) is null then 'the sync has never run'
    when (select status from checked) = 'error' then 'the last check failed: ' || coalesce((select message from checked), 'no message')
    when now() - (select finished_at from any_run) > interval '90 minutes' then 'no run in over 90 minutes: the scheduler is not calling the sync'
    when coalesce((select fallback_used from good), false) then 'the league''s report could not be read: statuses are from the ESPN fallback'
    when (select drift from a24) > 0 then 'the report''s layout or names drifted (see nba_injury_alerts)'
    else null
  end as state_reason
;

-- the research module's pipeline ledger reads {job}_last_run / {job}_last_status / row_count_{job}
create or replace view public.nba_injury_meta with (security_invoker = true) as
select 'nba_injury_sync_last_run'::text as key, (select finished_at::text from public.nba_injury_sync_runs where status <> 'skipped' order by finished_at desc limit 1) as value
union all select 'nba_injury_sync_last_status', (select case status when 'error' then 'error' when 'warn' then 'warn' else 'ok' end from public.nba_injury_sync_runs where status <> 'skipped' order by finished_at desc limit 1)
union all select 'row_count_nba_injury_sync', (select rows_read::text from public.nba_injury_sync_runs where status in ('ok', 'warn') order by finished_at desc limit 1)
union all select 'nba_roster_sync_last_run', (select max(captured_at)::text from public.nba_roster_captures)
union all select 'nba_adjusted_projection_last_run', (select max(computed_at)::text from public.nba_adjusted_projection_snapshots);

-- ---------------------------------------------------------------- the card
-- What a game card shows about who is playing, with the freshness rule in one
-- place. state:
--   AVAILABLE      the league's report covers this game, checked recently
--   FALLBACK       the league's report could not be read; ESPN's statuses (labelled)
--   NOT_ON_REPORT  checked recently, but this game is not on the latest report yet
--   UNAVAILABLE    no report, the last check failed, or no check recently enough
--   PREGAME        the game has started: the last report captured before tip
-- The adjusted projection is returned only with AVAILABLE / FALLBACK / PREGAME
-- and only when it was computed from the report shown.
create or replace function public.nba_injury_card(p_game_id text, p_home_id text, p_away_id text, p_start_utc timestamptz)
returns jsonb language plpgsql stable security invoker set search_path = public as $c$
declare
  L record; S record; rep record; proj record;
  max_check int := coalesce((select value::int from public.nba_injury_config where key = 'check_max_age_minutes'), 75);
  max_off int := coalesce((select value::int from public.nba_injury_config where key = 'offday_max_age_hours'), 26);
  started boolean := p_start_utc is not null and p_start_utc <= now();
  stale boolean; covered boolean; ns jsonb; st text; why text; statuses jsonb; rosters jsonb;
begin
  -- every record is assigned before it is read (an unassigned record raises)
  select p.* into rep from public.nba_injury_reports p where false;
  select a.* into proj from public.nba_adjusted_projection_snapshots a where false;
  select * into L from public.nba_injury_sync_runs where status <> 'skipped' order by finished_at desc limit 1;
  select * into S from public.nba_injury_sync_runs where status in ('ok', 'warn') order by finished_at desc limit 1;
  if started then
    -- the last report captured before tip that covers the game
    select p.* into rep from public.nba_injury_reports p
     where p.captured_at < p_start_utc and exists (select 1 from jsonb_array_elements(p.matchups) m where m ->> 'game_id' = p_game_id)
     order by p.captured_at desc, p.id desc limit 1;
    st := case when rep.id is null then 'UNAVAILABLE' else 'PREGAME' end;
    why := case when rep.id is null then 'no injury report covering this game was captured before tip' else null end;
  elsif L.run_id is null then
    st := 'UNAVAILABLE'; why := 'the injury sync has not run yet';
  elsif L.status = 'error' then
    st := 'UNAVAILABLE'; why := 'the last check failed: ' || coalesce(L.message, 'no message');
  else
    stale := now() - L.finished_at > case when exists (select 1 from public.nba_injury_sync_runs where status = 'skipped' and finished_at > L.finished_at)
                                          then make_interval(hours => max_off) else make_interval(mins => max_check) end;
    if stale then
      st := 'UNAVAILABLE'; why := 'no check since ' || to_char(L.finished_at at time zone 'America/New_York', 'Mon DD HH12:MI AM') || ' ET';
    else
      select p.* into rep from public.nba_injury_reports p where p.id = S.report_id;
      covered := rep.id is not null and exists (select 1 from jsonb_array_elements(rep.matchups) m where m ->> 'game_id' = p_game_id);
      if rep.id is null then st := 'UNAVAILABLE'; why := 'no injury report has been read';
      elsif not covered then st := 'NOT_ON_REPORT'; why := 'this game is not on the latest injury report yet';
      elsif rep.source = 'espn_injuries' then st := 'FALLBACK'; why := 'the league''s report could not be read; statuses are ESPN''s (third party)';
      else st := 'AVAILABLE'; why := null;
      end if;
    end if;
  end if;

  if st in ('AVAILABLE', 'FALLBACK', 'PREGAME') then
    select coalesce(jsonb_agg(jsonb_build_object('team_id', r.team_id, 'team_abbr', r.team_abbr, 'player_id', r.player_id, 'player_name', r.player_name, 'status', r.status,
             'source_status', r.source_status, 'reason', r.reason, 'match_method', r.match_method, 'row_id', r.id) order by r.team_id, r.status, r.player_name), '[]'::jsonb)
      into statuses from public.nba_injury_report_snapshots r where r.report_id = rep.id and r.game_id = p_game_id;
    select coalesce(jsonb_agg(x), '[]'::jsonb) into ns from jsonb_array_elements(rep.not_submitted) x where x ->> 'game_id' = p_game_id;
    select * into proj from public.nba_adjusted_projection_snapshots a
     where a.game_id = p_game_id and a.injury_report_id = rep.id and (not started or a.computed_at < p_start_utc)
     order by a.computed_at desc, a.id desc limit 1;
  end if;

  select coalesce(jsonb_object_agg(team_id, jsonb_build_object('capture_id', capture_id, 'captured_at', captured_at, 'source', source, 'players', players)), '{}'::jsonb) into rosters from (
    select r.team_id, max(r.capture_id) as capture_id, max(r.captured_at) as captured_at, max(r.source) as source,
           jsonb_agg(jsonb_build_object('player_id', r.player_id, 'player_name', r.player_name, 'roster_status', r.roster_status) order by r.player_name) as players
      from public.nba_roster_current r where r.team_id in (p_home_id, p_away_id) group by r.team_id) t;

  return jsonb_build_object(
    'game_id', p_game_id, 'state', st, 'reason', why, 'now', now(),
    'last_check_at', L.finished_at, 'last_check_status', L.status, 'last_success_at', S.finished_at,
    'report', case when rep.id is null then null else jsonb_build_object('id', rep.id, 'source', rep.source, 'source_url', rep.source_url, 'published_at', rep.report_published_at,
                    'captured_at', rep.captured_at, 'latest_seen_published_at', case when S.report_id = rep.id then S.report_published_at else rep.report_published_at end) end,
    'statuses', coalesce(statuses, '[]'::jsonb), 'not_submitted', coalesce(ns, '[]'::jsonb), 'rosters', rosters,
    'adjusted', case when proj.id is null then null else jsonb_build_object('id', proj.id, 'status', proj.status, 'reasons', proj.reasons, 'model_key', proj.model_key, 'model_version', proj.model_version,
                    'model_version_ref', proj.model_version_ref, 'injury_report_id', proj.injury_report_id, 'report_source', proj.report_source, 'slate_generated_at', proj.slate_generated_at,
                    'computed_at', proj.computed_at, 'baseline', proj.baseline, 'adjusted', proj.adjusted, 'delta', proj.delta, 'adjustments', proj.adjustments,
                    'roster_changes', proj.roster_changes, 'home_roster_capture_id', proj.home_roster_capture_id, 'away_roster_capture_id', proj.away_roster_capture_id, 'impact_snapshot_id', proj.impact_snapshot_id) end);
end $c$;

-- ---------------------------------------------------------------- access
do $p$ declare t text; begin
  foreach t in array array['nba_injury_config', 'nba_injury_sync_runs', 'nba_injury_alerts', 'nba_roster_captures', 'nba_roster_snapshots', 'nba_injury_reports',
                           'nba_injury_report_snapshots', 'nba_player_impact_snapshots', 'nba_adjusted_projection_snapshots'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to anon, authenticated using (true)', t || '_read', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to anon, authenticated', t);
  end loop;
end $p$;
grant select on public.nba_roster_current, public.nba_roster_changes, public.nba_player_status_current, public.nba_adjusted_projection_current,
                public.nba_injury_readiness, public.nba_injury_meta to anon, authenticated;
revoke all on function public.nba_injury_card(text, text, text, timestamptz) from public;
grant execute on function public.nba_injury_card(text, text, text, timestamptz) to anon, authenticated;
revoke all on function public.nba_injury_keep() from public, anon, authenticated;
revoke all on function public.nba_adjusted_projection_registered() from public, anon, authenticated;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert on public.nba_injury_sync_runs, public.nba_injury_alerts, public.nba_roster_captures, public.nba_roster_snapshots, public.nba_injury_reports, public.nba_injury_report_snapshots, public.nba_player_impact_snapshots, public.nba_adjusted_projection_snapshots to service_role';
    execute 'grant select on public.nba_injury_config to service_role';
    execute 'grant select on public.nba_roster_current, public.nba_roster_changes, public.nba_player_status_current, public.nba_adjusted_projection_current, public.nba_injury_readiness, public.nba_injury_meta to service_role';
    execute 'grant usage, select on all sequences in schema public to service_role';
    execute 'grant execute on function public.nba_injury_card(text, text, text, timestamptz) to service_role';
  end if;
end $g$;

commit;

notify pgrst, 'reload schema';

-- THE REPORT. Every row should say ok.
select piece, state from (
  select '1 eight append-only tables' as piece,
         case when (select count(*) from pg_trigger where tgname like 'nba\_%\_frozen' escape '\' and not tgisinternal) >= 8 then 'ok' else 'CHECK THIS' end as state
  union all select '2 row level security on every table',
         case when (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relname in ('nba_injury_config', 'nba_injury_sync_runs', 'nba_injury_alerts', 'nba_roster_captures', 'nba_roster_snapshots',
              'nba_injury_reports', 'nba_injury_report_snapshots', 'nba_player_impact_snapshots', 'nba_adjusted_projection_snapshots') and relrowsecurity) = 9 then 'ok' else 'CHECK THIS' end
  union all select '3 no client write policy',
         case when not exists (select 1 from pg_policies where schemaname = 'public' and tablename like 'nba\_%' escape '\' and cmd <> 'SELECT') then 'ok' else 'CHECK THIS' end
  union all select '4 a projection must name the registered version',
         case when exists (select 1 from pg_trigger where tgname = 'nba_adjusted_projection_registered') then 'ok' else 'CHECK THIS' end
  union all select '5 the model version is registered',
         case when exists (select 1 from public.nba_injury_config where key = 'roster_model_version_ref') then 'ok'
              else 'pending: apply supabase/nba_roster_adjusted_registry.sql next (until then no projection can be stored)' end
  union all select '6 the readiness view answers', case when (select count(*) from public.nba_injury_readiness) = 1 then 'ok' else 'CHECK THIS' end
) r order by 1;
