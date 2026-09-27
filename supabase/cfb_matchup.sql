-- =============================================================================
-- cfb_matchup — the Postgres half of the CFB scheme and matchup intelligence
-- engine (docs/cfb-matchup/METHODS.md; the Python side is
-- football/cfb_v2/research/v2/matchup/, hook.matchup_week()).
--
-- WHAT IT IS
--   Point-in-time team style (cfb_team_week_style), the per-game matchup
--   snapshot the weekly engine records at its freeze (cfb_game_matchup_features:
--   general fair margin, matchup adjustment, matchup-aware margin, confidence,
--   explanation), the algorithmic similar-matchup comparisons
--   (cfb_similar_matchups), statistically detected style changes
--   (cfb_style_change_events), the versions of every matchup component and their
--   champion/challenger status (cfb_matchup_model_versions), and the prospective
--   Model Lab monitoring rows (cfb_matchup_monitor). Each table has typed columns
--   for what is queried and `payload jsonb` holding the complete row exactly as
--   the engine wrote it.
--
-- THE RULES, ENFORCED BY THE SERVER
--   1. Append-only. BEFORE UPDATE / DELETE / TRUNCATE triggers on every table
--      raise restrict_violation (the service role included). A correction is a
--      new state_version that names what it supersedes; a historical snapshot is
--      never overwritten.
--   2. Exactly once. One row per natural key (and state_version).
--   3. Point in time. A matchup snapshot is frozen before kickoff; a similar
--      matchup may only cite a comparison game that kicked off before the target
--      prediction; a style event is detected after the game that triggered it.
--   4. Matchup intelligence is a CORRECTION: the matchup-aware margin is the
--      general margin plus the adjustment; a NO_ADJUSTMENT model adjusts by
--      exactly 0; no adjustment exceeds the documented 3-point safety cap.
--   5. No statistical style event below its calibrated threshold (random weekly
--      variation never creates an event).
--   6. No matchup component becomes CHAMPION without a person and evidence.
--   7. Who reads what. authenticated may SELECT; anon nothing; writes only from
--      the service role (insert).
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- Tested against a real PostgreSQL by football/cfb_matchup/sql.test.js.
-- =============================================================================

create table if not exists public.cfb_team_week_style (
  style_id                      text primary key,
  team_id                       text not null,
  season                        int not null,
  week                          int,
  as_of                         timestamptz not null,
  feature_version               text not null,
  style_games                   numeric not null default 0,
  offensive_scheme_continuity   numeric,
  defensive_scheme_continuity   numeric,
  head_coach_new                boolean,
  style_drift_p                 numeric,
  state_version                 int not null default 1,
  supersedes                    text,
  reason                        text,
  run_id                        text,
  payload                       jsonb not null,
  recorded_at                   timestamptz not null default now(),
  constraint cfb_team_week_style_id check (style_id ~ '^cfbms_[0-9a-f]{24}$'),
  constraint cfb_team_week_style_cont check ((offensive_scheme_continuity is null or offensive_scheme_continuity between 0 and 1)
    and (defensive_scheme_continuity is null or defensive_scheme_continuity between 0 and 1)),
  constraint cfb_team_week_style_p check (style_drift_p is null or style_drift_p between 0 and 1),
  constraint cfb_team_week_style_games check (style_games >= 0),
  constraint cfb_team_week_style_version check (state_version >= 1 and (state_version = 1) = (supersedes is null)),
  constraint cfb_team_week_style_payload check (coalesce(jsonb_typeof(payload -> 'style'), 'missing') = 'object')
);
create unique index if not exists cfb_team_week_style_key
  on public.cfb_team_week_style (team_id, season, as_of, feature_version, state_version);
comment on table public.cfb_team_week_style is
  'Point-in-time style per team x freeze: style_mean and style_sd per metric (payload.style), scheme continuity, active style events.';

create table if not exists public.cfb_game_matchup_features (
  matchup_id                  text primary key,
  game_id                     text not null,
  season                      int not null,
  week                        int,
  prediction_ts               timestamptz not null,
  kickoff_ts                  timestamptz not null,
  base_model_version          text not null,
  feature_version             text not null,
  style_version               text not null,
  similarity_version          text not null,
  matchup_model_version       text not null,
  matchup_model_status        text not null,
  general_fair_margin         numeric not null,
  matchup_adjustment_points   numeric not null,
  matchup_aware_margin        numeric not null,
  matchup_confidence          numeric,
  shadow_adjustment_points    numeric,
  expected_possessions        numeric,
  input_hash                  text not null,
  run_id                      text,
  payload                     jsonb not null,
  recorded_at                 timestamptz not null default now(),
  constraint cfb_game_matchup_id check (matchup_id ~ '^cfbmg_[0-9a-f]{24}$'),
  constraint cfb_game_matchup_pit check (prediction_ts < kickoff_ts),
  constraint cfb_game_matchup_status check (matchup_model_status in ('ADJUST','NO_ADJUSTMENT')),
  constraint cfb_game_matchup_noadj check (matchup_model_status = 'ADJUST' or matchup_adjustment_points = 0),
  constraint cfb_game_matchup_cap check (abs(matchup_adjustment_points) <= 3 and (shadow_adjustment_points is null or abs(shadow_adjustment_points) <= 3)),
  constraint cfb_game_matchup_sum check (abs(matchup_aware_margin - (general_fair_margin + matchup_adjustment_points)) < 0.002),
  constraint cfb_game_matchup_conf check (matchup_confidence is null or matchup_confidence between 0 and 1),
  constraint cfb_game_matchup_poss check (expected_possessions is null or expected_possessions > 0),
  constraint cfb_game_matchup_expl check (coalesce(jsonb_typeof(payload -> 'explanation'), 'missing') = 'object')
);
create unique index if not exists cfb_game_matchup_key
  on public.cfb_game_matchup_features (game_id, prediction_ts, feature_version, matchup_model_version, input_hash);
comment on table public.cfb_game_matchup_features is
  'Immutable matchup snapshot per game x freeze: general vs matchup-aware fair margin, confidence, number-only explanation.';

create table if not exists public.cfb_similar_matchups (
  similar_id               text primary key,
  target_game_id           text not null,
  comparison_game_id       text not null,
  team_side                text not null,
  team_id                  text not null,
  prediction_ts            timestamptz not null,
  comparison_kickoff_ts    timestamptz not null,
  similarity_score         numeric not null,
  feature_distance         numeric,
  eligible_pre_prediction  boolean not null,
  display_allowed          boolean not null default false,
  similarity_version       text not null,
  payload                  jsonb not null,
  recorded_at              timestamptz not null default now(),
  constraint cfb_similar_id check (similar_id ~ '^cfbmx_[0-9a-f]{24}$'),
  constraint cfb_similar_side check (team_side in ('home','away')),
  constraint cfb_similar_score check (similarity_score >= 0 and similarity_score <= 1),
  constraint cfb_similar_dist check (feature_distance is null or feature_distance >= 0),
  constraint cfb_similar_pit check (eligible_pre_prediction and comparison_kickoff_ts < prediction_ts),
  constraint cfb_similar_self check (comparison_game_id <> target_game_id)
);
create unique index if not exists cfb_similar_key
  on public.cfb_similar_matchups (target_game_id, team_side, comparison_game_id, prediction_ts, similarity_version);
comment on table public.cfb_similar_matchups is
  'Algorithmic similar-opponent comparisons (never manual): only games that kicked off before the target prediction.';

create table if not exists public.cfb_style_change_events (
  event_id          text primary key,
  team_id           text not null,
  season            int not null,
  event_type        text not null,
  metric            text,
  trigger_game_id   text,
  detected_at       timestamptz,
  z                 numeric,
  threshold         numeric,
  rule_version      text not null,
  payload           jsonb not null,
  recorded_at       timestamptz not null default now(),
  constraint cfb_style_event_id check (event_id ~ '^cfbme_[0-9a-f]{24}$'),
  constraint cfb_style_event_type check (event_type in ('RUN_PASS_SHIFT','PACE_REGIME_CHANGE','QB_USAGE_SHIFT',
    'PRESSURE_SHIFT','COORDINATOR_CHANGE_OFF','COORDINATOR_CHANGE_DEF')),
  constraint cfb_style_event_stat check (event_type in ('COORDINATOR_CHANGE_OFF','COORDINATOR_CHANGE_DEF')
    or (z is not null and threshold is not null and threshold > 0 and abs(z) >= threshold and trigger_game_id is not null
        and detected_at is not null))
);
create unique index if not exists cfb_style_event_key
  on public.cfb_style_change_events (team_id, season, event_type, coalesce(trigger_game_id, ''), rule_version);

create table if not exists public.cfb_matchup_model_versions (
  version_row_id       text primary key,
  component            text not null,
  version              text not null,
  status               text not null,
  base_model_version   text not null,
  artifact_sha256      text,
  decided_at           timestamptz not null,
  decided_by           text,
  evidence             text,
  payload              jsonb not null,
  recorded_at          timestamptz not null default now(),
  constraint cfb_matchup_version_id check (version_row_id ~ '^cfbmv_[0-9a-f]{24}$'),
  constraint cfb_matchup_version_component check (component in ('style','similarity','residual','variance',
    'play_selection','clustering','change_points')),
  constraint cfb_matchup_version_status check (status in ('CHAMPION','CHALLENGER','NO_ADJUSTMENT','REJECTED','RETIRED')),
  constraint cfb_matchup_version_champion check (status <> 'CHAMPION' or (decided_by is not null and evidence is not null)),
  constraint cfb_matchup_version_sha check (artifact_sha256 is null or artifact_sha256 ~ '^[0-9a-f]{64}$')
);
create unique index if not exists cfb_matchup_version_key
  on public.cfb_matchup_model_versions (component, version, status, decided_at);

create table if not exists public.cfb_matchup_monitor (
  monitor_id            text primary key,
  season                int not null,
  week                  int,
  as_of                 timestamptz not null,
  matchup_model_version text not null,
  n_games               int not null,
  mae_general           numeric,
  mae_matchup           numeric,
  mae_shadow            numeric,
  payload               jsonb not null,
  recorded_at           timestamptz not null default now(),
  constraint cfb_matchup_monitor_id check (monitor_id ~ '^cfbmm_[0-9a-f]{24}$'),
  constraint cfb_matchup_monitor_n check (n_games >= 0)
);
create unique index if not exists cfb_matchup_monitor_key
  on public.cfb_matchup_monitor (season, coalesce(week, -1), as_of, matchup_model_version);
comment on table public.cfb_matchup_monitor is
  'Prospective Model Lab monitoring: are matchup corrections (production and shadow challenger) helping? Never a trigger by itself.';

-- ===================================================== append-only + access
create or replace function public.cfb_matchup_append_only()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $fn$
begin
  if tg_op = 'UPDATE' then
    raise exception '% is append-only: rows are never updated (a correction is a new state_version)', tg_table_name
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
  foreach t in array array['cfb_team_week_style','cfb_game_matchup_features','cfb_similar_matchups',
    'cfb_style_change_events','cfb_matchup_model_versions','cfb_matchup_monitor']
  loop
    execute format('drop trigger if exists %I on public.%I', t || '_no_update_trg', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.cfb_matchup_append_only()', t || '_no_update_trg', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_delete_trg', t);
    execute format('create trigger %I before delete on public.%I for each row execute function public.cfb_matchup_append_only()', t || '_no_delete_trg', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate_trg', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.cfb_matchup_append_only()', t || '_no_truncate_trg', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_read', t);
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

-- The newest style state of every team and freeze.
create or replace view public.cfb_team_week_style_current as
select distinct on (s.team_id, s.season, s.as_of, s.feature_version) s.*
  from public.cfb_team_week_style s
 order by s.team_id, s.season, s.as_of, s.feature_version, s.state_version desc;

-- The newest decision per matchup component.
create or replace view public.cfb_matchup_model_status as
select distinct on (v.component) v.*
  from public.cfb_matchup_model_versions v
 order by v.component, v.decided_at desc, v.recorded_at desc;

-- The latest matchup snapshot per game (what the product shows).
create or replace view public.cfb_game_matchup_latest as
select distinct on (m.game_id) m.*
  from public.cfb_game_matchup_features m
 order by m.game_id, m.prediction_ts desc, m.recorded_at desc;

do $blk$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant select on public.cfb_team_week_style_current to authenticated';
    execute 'grant select on public.cfb_matchup_model_status to authenticated';
    execute 'grant select on public.cfb_game_matchup_latest to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.cfb_team_week_style_current from anon';
    execute 'revoke all on public.cfb_matchup_model_status from anon';
    execute 'revoke all on public.cfb_game_matchup_latest from anon';
  end if;
end $blk$;

notify pgrst, 'reload schema';

-- ================================================================= report
with tables(t) as (
  values ('cfb_team_week_style'),('cfb_game_matchup_features'),('cfb_similar_matchups'),
         ('cfb_style_change_events'),('cfb_matchup_model_versions'),('cfb_matchup_monitor')
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
  select 2, 'exactly-once keys (style, matchup, similar, events, versions, monitor)',
         case when to_regclass('public.cfb_team_week_style_key') is not null
               and to_regclass('public.cfb_game_matchup_key') is not null
               and to_regclass('public.cfb_similar_key') is not null
               and to_regclass('public.cfb_style_event_key') is not null
               and to_regclass('public.cfb_matchup_version_key') is not null
               and to_regclass('public.cfb_matchup_monitor_key') is not null
              then 'ok' else 'CHECK THIS' end
  union all
  select 3, 'views: cfb_team_week_style_current, cfb_matchup_model_status, cfb_game_matchup_latest',
         case when to_regclass('public.cfb_team_week_style_current') is not null
               and to_regclass('public.cfb_matchup_model_status') is not null
               and to_regclass('public.cfb_game_matchup_latest') is not null then 'ok' else 'CHECK THIS' end
  union all
  select 4, 'correction rules (NO_ADJUSTMENT = 0, cap 3, aware = general + adjustment)',
         case when exists (select 1 from pg_constraint where conname = 'cfb_game_matchup_noadj')
               and exists (select 1 from pg_constraint where conname = 'cfb_game_matchup_cap')
               and exists (select 1 from pg_constraint where conname = 'cfb_game_matchup_sum') then 'ok' else 'CHECK THIS' end
  union all
  select 5, 'point in time (snapshot before kickoff; comparisons before the prediction)',
         case when exists (select 1 from pg_constraint where conname = 'cfb_game_matchup_pit')
               and exists (select 1 from pg_constraint where conname = 'cfb_similar_pit') then 'ok' else 'CHECK THIS' end
) r
order by ord, check_name;
