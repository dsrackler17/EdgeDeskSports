-- MODEL COLLECTIVE, COMPLETE DATABASE SETUP
-- Paste this whole file into the Supabase dashboard SQL editor and run it once.
-- It creates the collective schema, every table, view, function, and seed.
-- (Concatenation of supabase/migrations/*.sql in order.)


-- ============================================================
-- 20260819000001_collective_foundation.sql
-- ============================================================
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

-- ============================================================
-- 20260819000002_collective_creators.sql
-- ============================================================
-- Model Collective, migration 2: creators, models, api keys, invite tokens.
-- user_id is a bare uuid on purpose: no FK into auth.users, so the schema
-- stays liftable (rule 8.1). Identity always comes from the authenticated
-- key or JWT, never from payload strings (rule 8.2).

create table collective.creators (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid unique,
  slug               text not null unique
                       check (slug ~ '^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$'),
  display_name       text not null check (length(display_name) between 2 and 60),
  description        text,
  website_url        text,
  x_handle           text,
  logo_url           text,
  status             collective.creator_status not null default 'active',
  is_listed          boolean not null default true,
  founding_member    boolean not null default false,
  -- The money number travels on the creator record, not on a tier check,
  -- so founding terms survive any later tier changes (Section 5).
  referral_share_bps int not null default 4000 check (referral_share_bps between 0 and 10000),
  billing_mode       collective.billing_mode not null default 'referral',
  pinned_model_id    uuid,
  invite_token_id    uuid,
  created_at         timestamptz not null default now()
);
alter table collective.creators enable row level security;
grant select, insert, update on collective.creators to service_role;

create table collective.models (
  id          uuid primary key default gen_random_uuid(),
  creator_id  uuid not null references collective.creators(id) on delete restrict,
  slug        text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$'),
  name        text not null check (length(name) between 2 and 60),
  sport_code  text not null references collective.sports(code),
  description text,
  is_listed   boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (creator_id, slug)
);
alter table collective.models enable row level security;
grant select, insert, update on collective.models to service_role;

-- Keys: mck_live_/mck_test_ + 8 char prefix + 32 char secret. Only the
-- prefix and the sha256 of the full raw key are stored; the raw key is
-- shown exactly once at issue time.
create table collective.api_keys (
  id           uuid primary key default gen_random_uuid(),
  creator_id   uuid not null references collective.creators(id),
  model_id     uuid references collective.models(id),
  scope        collective.key_scope not null default 'submit',
  kind         text not null default 'live' check (kind in ('live','test')),
  key_prefix   text not null unique,
  key_hash     text not null,
  status       collective.key_status not null default 'active',
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index api_keys_creator on collective.api_keys (creator_id);
alter table collective.api_keys enable row level security;
grant select, insert, update on collective.api_keys to service_role;

-- Invite tokens: the entire join flow is one link (Section 6). Hashed at
-- rest; the raw token is shown once to the founder at mint time.
create table collective.invite_tokens (
  id                 uuid primary key default gen_random_uuid(),
  token_hash         text not null unique,
  token_prefix       text not null,
  prefill            jsonb not null default '{}'::jsonb,
  founding_member    boolean not null default false,
  referral_share_bps int check (referral_share_bps between 0 and 10000),
  max_uses           int not null default 1 check (max_uses >= 1),
  use_count          int not null default 0,
  expires_at         timestamptz not null,
  note               text,
  created_by         uuid,
  created_at         timestamptz not null default now()
);
alter table collective.invite_tokens enable row level security;
grant select, insert, update on collective.invite_tokens to service_role;

-- Join requests from dead-token pages: stored, not just logged, so a lost
-- creator is never silently dropped.
create table collective.join_requests (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  note       text,
  token_seen text,
  created_at timestamptz not null default now()
);
alter table collective.join_requests enable row level security;
grant select, insert on collective.join_requests to service_role;

-- ============================================================
-- 20260819000003_collective_submissions.sql
-- ============================================================
-- Model Collective, migration 3: submissions and projections, append-only.
-- Submissions are immutable observations (rule 8.3): a revision is a new
-- row, UPDATE and DELETE are blocked for every path except the explicit
-- service maintenance GUC used by quarantine resolution and erasure.

create table collective.submissions (
  id                  uuid primary key default gen_random_uuid(),
  model_id            uuid not null references collective.models(id),
  api_key_id          uuid not null references collective.api_keys(id),
  -- Server receipt time is the only time trusted anywhere (rule 8.6).
  received_at         timestamptz not null default now(),
  data_origin         collective.data_origin not null,
  client_generated_at timestamptz,
  source_note         text,
  payload_hash        text not null,
  n_rows              int not null default 0,
  n_resolved          int not null default 0,
  n_quarantined       int not null default 0,
  n_late              int not null default 0,
  -- The exact response returned at ingest time, so an idempotent replay
  -- returns the original outcome verbatim (denormalization justified:
  -- recomputing it later could differ once quarantine gets resolved).
  response            jsonb,
  created_at          timestamptz not null default now(),
  unique (model_id, payload_hash)
);
create index submissions_model_time on collective.submissions (model_id, received_at desc);
alter table collective.submissions enable row level security;
grant select, insert on collective.submissions to service_role;

create table collective.projections (
  id                 uuid primary key default gen_random_uuid(),
  -- Deferrable: ingest writes projection rows first and the parent
  -- submissions row (carrying the final counts and stored response) last,
  -- inside one transaction. The constraint holds at commit.
  submission_id      uuid not null references collective.submissions(id) deferrable initially deferred,
  -- model_id, data_origin, received_at are denormalized from submissions:
  -- every read path (grading, coverage, movement, consensus) filters on
  -- them, and append-only rows never drift from their parent.
  model_id           uuid not null references collective.models(id),
  game_id            uuid references collective.games(id),
  raw_game_ref       text not null,
  raw_row            jsonb not null,
  resolution_status  collective.resolution_status not null,
  quarantine_reason  text,
  sport_code         text not null,
  season             int not null,
  week               int,
  pick_side          collective.pick_side,
  total_side         collective.total_side,
  line_at_submission numeric,
  projected_spread   numeric,
  projected_total    numeric,
  proj_home_score    numeric,
  proj_away_score    numeric,
  home_win_prob      numeric check (home_win_prob is null or (home_win_prob >= 0 and home_win_prob <= 1)),
  cover_prob         numeric check (cover_prob is null or (cover_prob >= 0 and cover_prob <= 1)),
  -- Creator-defined scale. Displayed only in the creator's own context,
  -- never aggregated (rule 9.5).
  confidence         numeric,
  data_origin        collective.data_origin not null,
  received_at        timestamptz not null,
  is_late            boolean not null default false,
  is_graded_candidate boolean not null default false,
  created_at         timestamptz not null default now(),
  -- A cover probability is meaningless without the line it was made
  -- against (rule 9.3).
  check (cover_prob is null or line_at_submission is not null),
  check (resolution_status = 'resolved' or game_id is null)
);

-- THE first-submission lock (rule 8.5). One graded candidate per model per
-- game, enforced structurally, not by convention. Everything later is
-- movement.
create unique index projections_first_lock
  on collective.projections (model_id, game_id)
  where is_graded_candidate;

create index projections_model_game on collective.projections (model_id, game_id, received_at);
create index projections_game on collective.projections (game_id) where game_id is not null;
create index projections_quarantined on collective.projections (received_at desc) where resolution_status = 'quarantined';
alter table collective.projections enable row level security;
grant select, insert on collective.projections to service_role;

-- ------------------------------------------------ append-only enforcement
-- Belt and braces on top of the missing UPDATE/DELETE grants: even the
-- table owner goes through the maintenance GUC, so nothing mutates these
-- rows casually. Quarantine resolution and GDPR erasure set the GUC inside
-- SECURITY DEFINER functions.

create or replace function collective.block_mutation() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('collective.maintenance', true), '') = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  raise exception 'collective.% is append-only (rule 8.3); use the service maintenance path', tg_table_name
    using errcode = 'raise_exception';
end $$;

create trigger submissions_append_only
  before update or delete on collective.submissions
  for each row execute function collective.block_mutation();

create trigger projections_append_only
  before update or delete on collective.projections
  for each row execute function collective.block_mutation();

-- ============================================================
-- 20260819000004_collective_grading.sql
-- ============================================================
-- Model Collective, migration 4: results, grades, and the grading engine.
-- Three separate metrics, never blended (rule 8.11), graded only against
-- the Collective's own captured closing line (rule 9.1), only on each
-- model's first pre-kickoff live submission (rule 8.5), reproducible from
-- raw tables by someone who does not trust us.

create table collective.results (
  game_id              uuid primary key references collective.games(id),
  home_score           int not null,
  away_score           int not null,
  -- Home convention, negative means home favored, same as projections.
  closing_spread       numeric,
  closing_total        numeric,
  closing_home_ml_prob numeric check (closing_home_ml_prob is null or (closing_home_ml_prob >= 0 and closing_home_ml_prob <= 1)),
  source               text,
  settled_at           timestamptz not null default now()
);
alter table collective.results enable row level security;
grant select, insert, update on collective.results to service_role;

create table collective.grades (
  projection_id   uuid primary key references collective.projections(id),
  game_id         uuid not null references collective.games(id),
  model_id        uuid not null references collective.models(id),
  pick_result     collective.grade_result,
  margin_error    numeric,
  total_error     numeric,
  brier           numeric,
  grading_version int not null default 1,
  graded_at       timestamptz not null default now()
);
create index grades_model on collective.grades (model_id);
create index grades_game on collective.grades (game_id);
alter table collective.grades enable row level security;
grant select on collective.grades to service_role;

-- Grades every candidate projection on a settled game. Deterministic:
-- rerunning it produces identical rows (grading_version stamps the rules).
create or replace function collective.grade_game(p_game_id uuid) returns int
language plpgsql security definer set search_path = collective as $$
declare
  r  collective.results%rowtype;
  p  record;
  v_margin numeric;
  v_pick collective.grade_result;
  v_marg_err numeric;
  v_tot_err numeric;
  v_brier numeric;
  v_n int := 0;
begin
  select * into r from collective.results where game_id = p_game_id;
  if not found then return 0; end if;
  v_margin := r.home_score - r.away_score;

  for p in
    select * from collective.projections
    where game_id = p_game_id and is_graded_candidate
  loop
    -- 1. Pick result vs the Collective closing spread. Home covers when
    --    margin + closing_spread > 0; the exact number is a push and is
    --    excluded from win percentage downstream.
    v_pick := null;
    if p.pick_side is not null and r.closing_spread is not null then
      if v_margin + r.closing_spread = 0 then
        v_pick := 'push';
      elsif (v_margin + r.closing_spread > 0) = (p.pick_side = 'home') then
        v_pick := 'win';
      else
        v_pick := 'loss';
      end if;
    end if;

    -- 2. Margin error. Projected home margin from scores when given, else
    --    from the spread (home convention: projected margin = -spread).
    v_marg_err := null;
    if p.proj_home_score is not null and p.proj_away_score is not null then
      v_marg_err := abs((p.proj_home_score - p.proj_away_score) - v_margin);
    elsif p.projected_spread is not null then
      v_marg_err := abs((-p.projected_spread) - v_margin);
    end if;

    v_tot_err := null;
    if p.projected_total is not null then
      v_tot_err := abs(p.projected_total - (r.home_score + r.away_score));
    end if;

    -- 3. Brier on the moneyline home win probability. A tie grades null:
    --    the outcome is neither a home win nor a home loss.
    v_brier := null;
    if p.home_win_prob is not null and v_margin <> 0 then
      v_brier := power(p.home_win_prob - (case when v_margin > 0 then 1 else 0 end), 2);
    end if;

    insert into collective.grades (projection_id, game_id, model_id, pick_result, margin_error, total_error, brier, grading_version)
    values (p.id, p_game_id, p.model_id, v_pick, v_marg_err, v_tot_err, v_brier, 1)
    on conflict (projection_id) do update
      set pick_result = excluded.pick_result,
          margin_error = excluded.margin_error,
          total_error = excluded.total_error,
          brier = excluded.brier,
          grading_version = excluded.grading_version,
          graded_at = now();
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke execute on function collective.grade_game(uuid) from public;
grant execute on function collective.grade_game(uuid) to service_role;

-- ============================================================
-- 20260819000005_collective_views.sql
-- ============================================================
-- Model Collective, migration 5: derived read models. Everything here is a
-- deterministic transform over the append-only tables (rules 8.7 to 8.10):
-- no view stores state, so every published number is reproducible.

-- Monogram fallback when a creator has no logo: first letters of the first
-- two words of the display name.
create or replace function collective.monogram(p_name text) returns text
language sql immutable as $$
  select upper(left(split_part(trim(p_name), ' ', 1), 1) ||
               left(split_part(trim(p_name), ' ', 2), 1))
$$;

-- Membership state is derived, never stored (rule 8.8): computed from live
-- submission recency against the in-season window of the creator's sports.
create or replace function collective.creator_membership(p_creator_id uuid) returns text
language plpgsql stable security definer set search_path = collective as $$
declare
  v_in_season boolean;
  v_last timestamptz;
  v_active_days int := collective.cfg_int('status.active_days', 10);
  v_inactive_days int := collective.cfg_int('status.inactive_days', 45);
begin
  select exists (
    select 1 from collective.models m
    join collective.sport_seasons ss on ss.sport_code = m.sport_code
    where m.creator_id = p_creator_id
      and current_date between ss.starts_on and ss.ends_on
  ) into v_in_season;

  select max(p.received_at) into v_last
  from collective.projections p
  join collective.models m on m.id = p.model_id
  where m.creator_id = p_creator_id
    and p.data_origin = 'live' and p.resolution_status = 'resolved';

  if v_last is null or not v_in_season then return 'MEMBER'; end if;
  if now() - v_last <= make_interval(days => v_active_days) then return 'ACTIVE CONTRIBUTOR'; end if;
  if now() - v_last >= make_interval(days => v_inactive_days) then return 'INACTIVE'; end if;
  return 'MEMBER';
end $$;

-- ---------------------------------------------------------------- reads

-- Newest resolved row per model per game, candidate or not.
create view collective.latest_projections as
select distinct on (p.model_id, p.game_id) p.*
from collective.projections p
where p.resolution_status = 'resolved'
order by p.model_id, p.game_id, p.received_at desc;

-- The graded numbers (rule 8.5): first pre-kickoff live submission each.
create view collective.first_submissions as
select p.* from collective.projections p where p.is_graded_candidate;

-- Every resolved row in receipt order: the movement trail.
create view collective.model_movement as
select p.model_id, p.game_id, p.id as projection_id, p.received_at, p.is_graded_candidate,
       p.is_late, p.data_origin, p.pick_side, p.projected_spread, p.projected_total,
       p.home_win_prob, p.line_at_submission
from collective.projections p
where p.resolution_status = 'resolved'
order by p.model_id, p.game_id, p.received_at;

-- Per-model record over graded candidates. Pushes are excluded from win
-- percentage (published grading rules). Null record = nothing graded yet.
create view collective.model_records as
select
  m.id as model_id,
  count(g.projection_id)                                   as graded,
  count(*) filter (where g.pick_result = 'win')            as wins,
  count(*) filter (where g.pick_result = 'loss')           as losses,
  count(*) filter (where g.pick_result = 'push')           as pushes,
  case when count(*) filter (where g.pick_result in ('win','loss')) > 0
       then round(count(*) filter (where g.pick_result = 'win')::numeric
                / count(*) filter (where g.pick_result in ('win','loss')), 4)
       end                                                 as win_pct,
  round(avg(g.margin_error), 2)                            as margin_mae,
  round(avg(g.total_error), 2)                             as total_mae,
  round(avg(g.brier), 4)                                   as brier
from collective.models m
join collective.grades g on g.model_id = m.id
group by m.id;

-- Slate coverage per model per week (rule 8.7): games available in the
-- sport-week versus games this model actually has a graded candidate on.
create view collective.model_coverage as
select
  m.id as model_id, g.season, g.week,
  count(distinct g.id)                                  as games_available,
  count(distinct fs.game_id)                            as games_submitted
from collective.models m
join collective.games g on g.sport_code = m.sport_code and g.week is not null
left join collective.first_submissions fs on fs.model_id = m.id and fs.game_id = g.id
group by m.id, g.season, g.week;

-- Season-to-date rollup: the slate that has actually become playable
-- (kickoff in the past) is the denominator.
create view collective.model_coverage_totals as
select
  m.id as model_id, g.season,
  count(distinct g.id)                       as games_available,
  count(distinct fs.game_id)                 as games_submitted,
  case when count(distinct g.id) > 0
       then round(100.0 * count(distinct fs.game_id) / count(distinct g.id), 1)
       else null end                         as coverage_pct
from collective.models m
join collective.games g on g.sport_code = m.sport_code and g.kickoff_at <= now()
left join collective.first_submissions fs on fs.model_id = m.id and fs.game_id = g.id
group by m.id, g.season;

-- Backfill stored and shown separately, never ranked (rule 9.4).
create view collective.model_backfill as
select p.model_id, count(*) as rows
from collective.projections p
where p.data_origin = 'backfill'
group by p.model_id;

-- One row per listed model of a listed, active creator: the wall.
create view collective.model_wall as
select
  c.id  as creator_id, c.slug as creator_slug, c.display_name as creator_name,
  c.logo_url, collective.monogram(c.display_name) as monogram,
  c.founding_member as founding, c.website_url, c.x_handle,
  collective.creator_membership(c.id) as membership,
  m.id as model_id, m.slug as model_slug, m.name as model_name, m.sport_code as sport,
  r.graded, r.wins, r.losses, r.pushes, r.win_pct, r.margin_mae, r.total_mae, r.brier,
  ct.coverage_pct,
  (select max(p.received_at) from collective.projections p
    where p.model_id = m.id and p.data_origin = 'live' and p.resolution_status = 'resolved')
    as last_submission_at
from collective.creators c
join collective.models m on m.creator_id = c.id and m.is_listed
left join collective.model_records r on r.model_id = m.id
left join collective.model_coverage_totals ct
  on ct.model_id = m.id
 and ct.season = (select max(season) from collective.sport_seasons ss where ss.sport_code = m.sport_code)
where c.is_listed and c.status = 'active';

-- Rankings: coverage-gated (rule 8.7), three metrics ranked separately and
-- never blended (rule 8.11). Below-threshold models come through with
-- is_ranked = false and a human-readable reason.
create view collective.model_rankings as
with cfg as (
  select collective.cfg_int('ranking.min_coverage_pct', 60) as min_cov,
         collective.cfg_int('ranking.min_graded_games', 20) as min_graded
), base as (
  select w.*, cfg.min_cov, cfg.min_graded,
         coalesce(w.coverage_pct, 0) >= cfg.min_cov
         and coalesce(w.graded, 0) >= cfg.min_graded as qualifies
  from collective.model_wall w cross join cfg
)
select
  b.creator_slug, b.creator_name, b.model_slug, b.model_name, b.sport,
  b.graded, b.coverage_pct, b.win_pct, b.margin_mae, b.brier,
  b.qualifies as is_ranked,
  case when b.qualifies then null
       when coalesce(b.graded, 0) < b.min_graded
         then format('%s graded games is below the %s minimum', coalesce(b.graded, 0), b.min_graded)
       else format('coverage %s%% is below the %s%% minimum', coalesce(b.coverage_pct, 0), b.min_cov)
  end as unranked_reason,
  case when b.qualifies and b.win_pct is not null
       then rank() over (partition by b.qualifies order by (case when b.qualifies then b.win_pct end) desc nulls last) end as rank_win_pct,
  case when b.qualifies and b.margin_mae is not null
       then rank() over (partition by b.qualifies order by (case when b.qualifies then b.margin_mae end) asc nulls last) end as rank_margin_mae,
  case when b.qualifies and b.brier is not null
       then rank() over (partition by b.qualifies order by (case when b.qualifies then b.brier end) asc nulls last) end as rank_brier
from base b;

-- Consensus (rule 8.9): a deterministic transform off first submissions
-- only, live origin only. Unweighted v1; a weighted version is a research
-- model and does not ship until it clears out-of-sample validation.
create view collective.consensus as
select
  fs.game_id,
  count(*)                                        as n,
  round(avg(fs.projected_spread), 2)              as spread_mean,
  round(percentile_cont(0.5) within group (order by fs.projected_spread)::numeric, 2) as spread_median,
  round(stddev_samp(fs.projected_spread), 2)      as spread_stdev,
  min(fs.projected_spread)                        as spread_min,
  max(fs.projected_spread)                        as spread_max,
  round(avg(fs.projected_total), 2)               as total_mean,
  round(percentile_cont(0.5) within group (order by fs.projected_total)::numeric, 2)  as total_median,
  round(avg(fs.home_win_prob), 4)                 as home_win_prob_mean,
  count(fs.pick_side)                             as n_picks,
  case when count(fs.pick_side) > 0
       then round(count(*) filter (where fs.pick_side = 'home')::numeric / count(fs.pick_side), 4)
       end                                        as pct_picks_home,
  case when count(fs.pick_side) > 0
       then round(greatest(count(*) filter (where fs.pick_side = 'home'),
                           count(*) filter (where fs.pick_side = 'away'))::numeric
                  / count(fs.pick_side), 4)
       end                                        as agreement
from collective.first_submissions fs
where fs.data_origin = 'live'
group by fs.game_id;

-- Unresolved rows quarantine visibly and never drop silently (rule 8.4).
create view collective.quarantine_queue as
select p.id as projection_id, c.slug as creator_slug, m.name as model_name,
       p.raw_game_ref, p.raw_row, p.quarantine_reason as reason,
       p.sport_code, p.season, p.received_at
from collective.projections p
join collective.models m on m.id = p.model_id
join collective.creators c on c.id = m.creator_id
where p.resolution_status = 'quarantined'
order by p.received_at desc;

-- Recent activity feed: submission events, no projection numbers.
create view collective.activity_feed as
select s.received_at as at, c.slug as creator_slug, c.display_name as creator_name,
       m.name as model_name, m.sport_code as sport, s.n_rows,
       (select count(*) from collective.projections p
         where p.submission_id = s.id and p.is_graded_candidate) as n_first,
       (select min(p.week) from collective.projections p where p.submission_id = s.id) as week
from collective.submissions s
join collective.models m on m.id = s.model_id
join collective.creators c on c.id = m.creator_id
where s.data_origin = 'live' and c.is_listed
order by s.received_at desc
limit 100;

-- Flat game rows with team codes, label, and result fields: the board's
-- spine, embeddable-free so PostgREST reads need no FK hints.
create view collective.game_detail as
select
  g.id as game_id, g.sport_code as sport, g.season, g.week, g.kickoff_at, g.status,
  ht.code as home, at_.code as away,
  at_.code || ' @ ' || ht.code as label,
  r.home_score, r.away_score, r.closing_spread, r.closing_total
from collective.games g
join collective.teams ht  on ht.id = g.home_team_id
join collective.teams at_ on at_.id = g.away_team_id
left join collective.results r on r.game_id = g.id;

-- Per-model rows for the board: graded candidates plus late rows (stored,
-- flagged, excluded from grading per rule 8.6 but shown honestly).
create view collective.board_models as
select
  p.game_id, p.model_id, c.slug as creator_slug, m.slug as model_slug,
  p.pick_side, p.projected_spread, p.projected_total, p.home_win_prob,
  p.received_at, p.is_late,
  gr.pick_result, gr.margin_error, gr.brier
from collective.projections p
join collective.models m on m.id = p.model_id and m.is_listed
join collective.creators c on c.id = m.creator_id and c.is_listed and c.status = 'active'
left join collective.grades gr on gr.projection_id = p.id
where p.resolution_status = 'resolved' and p.data_origin = 'live'
  and (p.is_graded_candidate or p.is_late);

-- Recent graded games per model, for the model detail page.
create view collective.model_game_log as
select
  p.model_id, p.game_id, gd.label, gd.kickoff_at, gd.week,
  p.pick_side, gd.closing_spread,
  case when gd.home_score is not null
       then gd.home_score::text || '-' || gd.away_score::text end as final,
  gr.pick_result, gr.margin_error, gr.brier, gr.graded_at,
  (select count(*) from collective.projections px
    where px.model_id = p.model_id and px.game_id = p.game_id
      and px.resolution_status = 'resolved') as movement_n
from collective.grades gr
join collective.projections p on p.id = gr.projection_id
join collective.game_detail gd on gd.game_id = gr.game_id;

grant select on collective.latest_projections, collective.first_submissions,
  collective.model_movement, collective.model_records, collective.model_coverage,
  collective.model_coverage_totals, collective.model_backfill, collective.model_wall,
  collective.model_rankings, collective.consensus, collective.quarantine_queue,
  collective.activity_feed, collective.game_detail, collective.board_models,
  collective.model_game_log to service_role;

-- ============================================================
-- 20260819000006_collective_commerce.sql
-- ============================================================
-- Model Collective, migration 6: distribution and money tables, inert.
-- Attribution, entitlement, and payout tables exist from the first day so
-- the data is captured before billing turns on (rule 8.13): retrofitting
-- attribution is impossible because the data was never captured.

-- Origin allowlist per creator: what makes the embed slug in page source
-- harmless anywhere else.
create table collective.embed_installs (
  id           uuid primary key default gen_random_uuid(),
  creator_id   uuid not null references collective.creators(id),
  origin       text not null,
  status       text not null default 'active' check (status in ('active','disabled')),
  last_seen_at timestamptz,
  created_at   timestamptz not null default now()
);
create unique index embed_installs_uniq on collective.embed_installs (creator_id, lower(origin));
alter table collective.embed_installs enable row level security;
grant select, insert, update, delete on collective.embed_installs to service_role;

-- Engagement evidence, append-only. Pays creators on bringing an audience,
-- never on being right (Section 5: never pay on model accuracy).
create table collective.embed_events (
  id               uuid primary key default gen_random_uuid(),
  creator_id       uuid references collective.creators(id),
  event_type       collective.embed_event_type not null,
  visitor_id       text,
  target_creator_id uuid,
  path             text,
  referrer         text,
  origin           text,
  occurred_at      timestamptz not null default now()
);
create index embed_events_creator_time on collective.embed_events (creator_id, occurred_at desc);
alter table collective.embed_events enable row level security;
grant select, insert on collective.embed_events to service_role;
create trigger embed_events_append_only
  before update or delete on collective.embed_events
  for each row execute function collective.block_mutation();

-- First touch attribution (Section 5): first wins, recorded on the embed
-- and on any Collective link carrying a creator slug.
create table collective.attribution_touches (
  id         uuid primary key default gen_random_uuid(),
  visitor_id text not null,
  creator_id uuid not null references collective.creators(id),
  source     text not null check (source in ('embed','link')),
  origin     text,
  touched_at timestamptz not null default now()
);
create index attribution_touches_visitor on collective.attribution_touches (visitor_id, touched_at);
alter table collective.attribution_touches enable row level security;
grant select, insert on collective.attribution_touches to service_role;
create trigger attribution_touches_append_only
  before update or delete on collective.attribution_touches
  for each row execute function collective.block_mutation();

-- Attribution locks at conversion and never moves: unique per subscriber,
-- no update grant, append-only trigger. Two creators cannot claim the same
-- subscriber.
create table collective.attributions (
  id                    uuid primary key default gen_random_uuid(),
  subscriber_user_id    uuid,
  subscriber_email_hash text,
  creator_id            uuid not null references collective.creators(id),
  visitor_id            text,
  source                text,
  locked_at             timestamptz not null default now()
);
create unique index attributions_user_uniq  on collective.attributions (subscriber_user_id)  where subscriber_user_id is not null;
create unique index attributions_email_uniq on collective.attributions (subscriber_email_hash) where subscriber_email_hash is not null;
alter table collective.attributions enable row level security;
grant select, insert on collective.attributions to service_role;
create trigger attributions_append_only
  before update or delete on collective.attributions
  for each row execute function collective.block_mutation();

-- The Collective's own subscribers (Mode A). Entitlement is checked by the
-- Collective at the API layer, never by a host site.
create table collective.subscribers (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid unique,
  email                  text,
  status                 collective.sub_status not null,
  plan                   text check (plan in ('monthly','annual')),
  stripe_customer_id     text,
  stripe_subscription_id text unique,
  attribution_id         uuid references collective.attributions(id),
  current_period_end     timestamptz,
  started_at             timestamptz not null default now(),
  canceled_at            timestamptz,
  created_at             timestamptz not null default now()
);
alter table collective.subscribers enable row level security;
grant select, insert, update on collective.subscribers to service_role;

-- Money movements, append-only. Earnings post per paid invoice at the
-- creator's own referral_share_bps; annual pays on the full amount when it
-- clears; clawbacks are negative rows inside payout.clawback_days; payouts
-- are negative rows when paid. Balance is always sum(amount_cents).
create table collective.earnings_ledger (
  id            uuid primary key default gen_random_uuid(),
  creator_id    uuid not null references collective.creators(id),
  subscriber_id uuid references collective.subscribers(id),
  entry_type    collective.ledger_type not null,
  amount_cents  int not null,
  period_month  date not null,
  available_at  timestamptz,
  stripe_ref    text,
  note          text,
  created_at    timestamptz not null default now()
);
create index earnings_creator_month on collective.earnings_ledger (creator_id, period_month);
create unique index earnings_invoice_once
  on collective.earnings_ledger (stripe_ref) where entry_type = 'earning' and stripe_ref is not null;
-- Stripe delivers webhooks at least once: a replayed refund must not
-- double-debit the creator.
create unique index earnings_clawback_once
  on collective.earnings_ledger (stripe_ref) where entry_type = 'clawback' and stripe_ref is not null;
alter table collective.earnings_ledger enable row level security;
grant select, insert on collective.earnings_ledger to service_role;
create trigger earnings_ledger_append_only
  before update or delete on collective.earnings_ledger
  for each row execute function collective.block_mutation();

-- Stripe Connect is requested only after the first successful submission,
-- never at signup (Section 6).
create table collective.payout_accounts (
  creator_id        uuid primary key references collective.creators(id),
  stripe_connect_id text,
  status            text not null default 'unstarted' check (status in ('unstarted','requested','connected','disabled')),
  requested_at      timestamptz,
  connected_at      timestamptz
);
alter table collective.payout_accounts enable row level security;
grant select, insert, update on collective.payout_accounts to service_role;

-- Mode B seat reporting: minimum 10 seats, wholesale.seat_cents each,
-- billed monthly on actual seat count.
create table collective.wholesale_seats (
  id           uuid primary key default gen_random_uuid(),
  creator_id   uuid not null references collective.creators(id),
  period_month date not null,
  seat_count   int not null check (seat_count >= 10),
  reported_at  timestamptz not null default now(),
  invoiced     boolean not null default false,
  unique (creator_id, period_month)
);
alter table collective.wholesale_seats enable row level security;
grant select, insert, update on collective.wholesale_seats to service_role;

-- Sliding-window rate limiting evidence. Pruned by maintenance.
create table collective.api_request_log (
  id         bigint generated always as identity primary key,
  api_key_id uuid,
  endpoint   text,
  at         timestamptz not null default now()
);
create index api_request_log_window on collective.api_request_log (api_key_id, at desc);
alter table collective.api_request_log enable row level security;
grant select, insert on collective.api_request_log to service_role;
create trigger api_request_log_append_only
  before update or delete on collective.api_request_log
  for each row execute function collective.block_mutation();

-- Creator-facing earnings rollup: if a creator cannot see what the
-- Collective earned them this month, they will assume it is nothing.
create view collective.creator_earnings_monthly as
select
  c.id as creator_id, c.slug as creator_slug,
  l.period_month,
  sum(l.amount_cents) filter (where l.entry_type = 'earning')  as earned_cents,
  -sum(l.amount_cents) filter (where l.entry_type = 'clawback') as clawed_cents,
  -sum(l.amount_cents) filter (where l.entry_type = 'payout')   as paid_cents,
  sum(l.amount_cents)                                           as balance_cents,
  -- Earnings mature at available_at; clawbacks and payouts must always
  -- count against availability (clawbacks carry the available_at of the
  -- earning they reverse, payouts carry none).
  sum(l.amount_cents) filter (where l.available_at is null or l.available_at <= now())
                                                                as available_cents
from collective.creators c
join collective.earnings_ledger l on l.creator_id = c.id
group by c.id, c.slug, l.period_month;
grant select on collective.creator_earnings_monthly to service_role;

-- ============================================================
-- 20260819000007_collective_rpcs.sql
-- ============================================================
-- Model Collective, migration 7: the RPC surface. These are the only write
-- paths into the schema; edge functions call them via PostgREST with the
-- service role. All SECURITY DEFINER, all revoked from everyone else.
-- Convention: business outcomes return jsonb {ok:true,...} or
-- {ok:false, code, message}; raising is reserved for genuine failures.

-- ---------------------------------------------------------------- helpers

create or replace function collective.is_admin(p_user uuid) returns boolean
language sql stable security definer set search_path = collective as $$
  select coalesce(collective.cfg('admin.user_ids') ? p_user::text, false)
$$;

create or replace function collective.slugify(p_name text) returns text
language sql immutable as $$
  -- Clamped to the 40-char slug constraint; a name that collapses to
  -- nothing or one char falls back to 'creator'.
  select case when length(s) < 2 then 'creator' else s end from (
    select trim(both '-' from left(trim(both '-' from
      regexp_replace(lower(trim(p_name)), '[^a-z0-9]+', '-', 'g')), 40)) as s
  ) x
$$;

create or replace function collective.get_config(p_key text) returns jsonb
language sql stable security definer set search_path = collective as $$
  select collective.cfg(p_key)
$$;

-- ---------------------------------------------------------------- keys

create or replace function collective.verify_key(p_prefix text, p_hash text) returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  k record;
begin
  select ak.id, ak.kind, ak.status, ak.key_hash,
         c.id as creator_id, c.slug as creator_slug, c.display_name, c.status as creator_status,
         m.id as model_id, m.slug as model_slug, m.name as model_name, m.sport_code
  into k
  from collective.api_keys ak
  join collective.creators c on c.id = ak.creator_id
  left join collective.models m on m.id = ak.model_id
  where ak.key_prefix = p_prefix;

  -- is distinct from: a null or empty hash must never read as a match.
  if not found or coalesce(p_hash, '') = '' or k.key_hash is distinct from p_hash then
    return jsonb_build_object('ok', false, 'code', 'invalid_key', 'message', 'Unknown key');
  end if;
  if k.status <> 'active' or k.creator_status <> 'active' then
    return jsonb_build_object('ok', false, 'code', 'revoked_key', 'message', 'This key has been revoked');
  end if;

  update collective.api_keys set last_used_at = now() where id = k.id;

  return jsonb_build_object('ok', true,
    'key_id', k.id, 'kind', k.kind,
    'creator_id', k.creator_id, 'creator_slug', k.creator_slug, 'creator_name', k.display_name,
    'model_id', k.model_id, 'model_slug', k.model_slug, 'model_name', k.model_name,
    'sport', k.sport_code,
    'limits', jsonb_build_object(
      'max_rows', collective.cfg_int('ingest.max_rows', 500),
      'max_bytes', collective.cfg_int('ingest.max_bytes', 524288),
      'rate_per_hour', collective.cfg_int('ingest.rate_per_hour', 60)));
end $$;

create or replace function collective.rate_check(p_key_id uuid, p_endpoint text) returns boolean
language plpgsql security definer set search_path = collective as $$
declare
  v_limit int := collective.cfg_int('ingest.rate_per_hour', 60);
  v_count int;
begin
  insert into collective.api_request_log (api_key_id, endpoint) values (p_key_id, p_endpoint);
  select count(*) into v_count from collective.api_request_log
   where api_key_id = p_key_id and at > now() - interval '1 hour';
  return v_count <= v_limit;
end $$;

create or replace function collective.rotate_key(p_creator_id uuid, p_new_prefix text, p_new_hash text, p_kind text default 'live') returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  v_model uuid;
begin
  select model_id into v_model from collective.api_keys
   where creator_id = p_creator_id and status = 'active'
   order by created_at desc limit 1;
  update collective.api_keys
     set status = 'revoked', revoked_at = now()
   where creator_id = p_creator_id and status = 'active';
  insert into collective.api_keys (creator_id, model_id, kind, key_prefix, key_hash)
  values (p_creator_id, v_model, p_kind, p_new_prefix, p_new_hash);
  -- Historical submissions keep their attribution: rows reference the old
  -- key id and stay exactly where they are (append-only).
  return jsonb_build_object('ok', true, 'prefix', p_new_prefix);
end $$;

-- ---------------------------------------------------------------- games

create or replace function collective.resolve_team(p_sport text, p_alias text) returns uuid
language sql stable security definer set search_path = collective as $$
  select ta.team_id from collective.team_aliases ta
  where ta.sport_code = p_sport and lower(trim(ta.alias)) = lower(trim(p_alias))
  limit 1
$$;

-- Teams plus season plus nearest kickoff within 48 hours. The creator's
-- raw identifier is stored verbatim regardless (rule 8.4); this only finds
-- the canonical id.
create or replace function collective.resolve_game_ref(
  p_sport text, p_season int, p_home text, p_away text, p_kickoff timestamptz
) returns uuid
language plpgsql stable security definer set search_path = collective as $$
declare
  v_home uuid; v_away uuid; v_game uuid;
begin
  v_home := collective.resolve_team(p_sport, p_home);
  v_away := collective.resolve_team(p_sport, p_away);
  if v_home is null or v_away is null or p_kickoff is null then return null; end if;
  select g.id into v_game
  from collective.games g
  where g.sport_code = p_sport and g.season = p_season
    and g.home_team_id = v_home and g.away_team_id = v_away
    and abs(extract(epoch from g.kickoff_at - p_kickoff)) <= 48 * 3600
  order by abs(extract(epoch from g.kickoff_at - p_kickoff))
  limit 1;
  return v_game;
end $$;

create or replace function collective.upsert_games(p_admin uuid, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  v_sport text := p_payload->>'sport';
  v_season int := (p_payload->>'season')::int;
  g jsonb;
  v_home uuid; v_away uuid;
  v_n int := 0;
  v_fail jsonb := '[]'::jsonb;
begin
  if not collective.is_admin(p_admin) then
    return jsonb_build_object('ok', false, 'code', 'forbidden', 'message', 'Not an admin account');
  end if;
  if not exists (select 1 from collective.sports where code = v_sport) then
    return jsonb_build_object('ok', false, 'code', 'invalid_payload', 'message', 'Unknown sport');
  end if;
  for g in select * from jsonb_array_elements(coalesce(p_payload->'games', '[]'::jsonb)) loop
    v_home := collective.resolve_team(v_sport, g->>'home');
    v_away := collective.resolve_team(v_sport, g->>'away');
    if v_home is null or v_away is null or (g->>'kickoff') is null then
      v_fail := v_fail || jsonb_build_object('game', g, 'reason',
        case when v_home is null then 'unknown_team_home'
             when v_away is null then 'unknown_team_away'
             else 'missing_kickoff' end);
      continue;
    end if;
    insert into collective.games (sport_code, season, week, kickoff_at, home_team_id, away_team_id)
    values (v_sport, v_season, nullif(g->>'week','')::int, (g->>'kickoff')::timestamptz, v_home, v_away)
    on conflict (sport_code, season, home_team_id, away_team_id, ((kickoff_at at time zone 'UTC')::date))
    do update set week = excluded.week, kickoff_at = excluded.kickoff_at;
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'upserted', v_n, 'failed', v_fail);
end $$;

create or replace function collective.settle_game(p_admin uuid, p_game_id uuid, p_result jsonb) returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  v_graded int;
begin
  if not collective.is_admin(p_admin) then
    return jsonb_build_object('ok', false, 'code', 'forbidden', 'message', 'Not an admin account');
  end if;
  if not exists (select 1 from collective.games where id = p_game_id) then
    return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'No such game');
  end if;
  insert into collective.results (game_id, home_score, away_score, closing_spread, closing_total, closing_home_ml_prob, source)
  values (p_game_id,
          (p_result->>'home_score')::int, (p_result->>'away_score')::int,
          nullif(p_result->>'closing_spread','')::numeric,
          nullif(p_result->>'closing_total','')::numeric,
          nullif(p_result->>'closing_home_ml_prob','')::numeric,
          coalesce(p_result->>'source', 'admin'))
  on conflict (game_id) do update
    set home_score = excluded.home_score, away_score = excluded.away_score,
        closing_spread = excluded.closing_spread, closing_total = excluded.closing_total,
        closing_home_ml_prob = excluded.closing_home_ml_prob,
        source = excluded.source, settled_at = now();
  update collective.games set status = 'final' where id = p_game_id;
  v_graded := collective.grade_game(p_game_id);
  return jsonb_build_object('ok', true, 'graded', v_graded);
end $$;

-- ---------------------------------------------------------------- ingest

-- The whole row-level pipeline in one transaction: validation, canonical
-- resolution (8.4), late flagging vs server receipt time (8.6), the first
-- submission lock (8.5), quarantine that never fails a submission, counts,
-- and idempotent replay. p_dry computes identical outcomes, writes nothing.
create or replace function collective.ingest_submission(p_key jsonb, p_envelope jsonb, p_dry boolean default false) returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  v_model_id uuid := (p_key->>'model_id')::uuid;
  v_key_id uuid := (p_key->>'key_id')::uuid;
  v_sport text := p_envelope->>'sport';
  v_season int;
  v_origin collective.data_origin;
  v_received timestamptz := now();
  v_hash text;
  v_max_rows int := collective.cfg_int('ingest.max_rows', 500);
  v_rows jsonb := coalesce(p_envelope->'rows', '[]'::jsonb);
  row_j jsonb;
  v_out jsonb := '[]'::jsonb;
  v_sub_id uuid;
  v_game uuid;
  v_kick timestamptz;
  v_late boolean;
  v_candidate boolean;
  v_status text;
  v_reason text;
  n_res int := 0; n_quar int := 0; n_late int := 0; n_first int := 0; n_move int := 0; n_rej int := 0;
  v_resp jsonb;
  v_existing record;
  v_hwp numeric; v_spread numeric;
  v_pick collective.pick_side; v_tside collective.total_side;
  v_line numeric; v_ptot numeric; v_phs numeric; v_pas numeric;
  v_conf numeric; v_cover numeric; v_week int; v_env_week int;
  v_gen timestamptz;
begin
  -- Identity comes from the key, payload strings are only checked (8.2).
  if p_envelope ? 'model' and (p_envelope->>'model') is distinct from (p_key->>'model_slug') then
    return jsonb_build_object('ok', false, 'code', 'invalid_payload',
      'message', format('This key submits model "%s", not "%s"', p_key->>'model_slug', p_envelope->>'model'));
  end if;
  if v_sport is distinct from (p_key->>'sport') then
    return jsonb_build_object('ok', false, 'code', 'invalid_payload',
      'message', format('This key submits %s, the envelope says %s', p_key->>'sport', coalesce(v_sport, 'nothing')));
  end if;
  begin
    v_season := (p_envelope->>'season')::int;
  exception when others then v_season := null; end;
  if v_season is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_payload', 'message', 'season is required and must be an integer');
  end if;
  begin
    v_origin := (p_envelope->>'data_origin')::collective.data_origin;
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'invalid_payload', 'message', 'data_origin must be live, backfill, or test');
  end;
  -- A test key can only ever write test data.
  if (p_key->>'kind') = 'test' then v_origin := 'test'; end if;

  -- Envelope-level optionals are never allowed to abort the submission.
  begin v_env_week := nullif(p_envelope->>'week','')::int; exception when others then v_env_week := null; end;
  begin v_gen := nullif(p_envelope->>'generated_at','')::timestamptz; exception when others then v_gen := null; end;

  if jsonb_typeof(v_rows) <> 'array' or jsonb_array_length(v_rows) = 0 then
    return jsonb_build_object('ok', false, 'code', 'invalid_payload', 'message', 'rows must be a non-empty array');
  end if;
  if jsonb_array_length(v_rows) > v_max_rows then
    return jsonb_build_object('ok', false, 'code', 'invalid_payload',
      'message', format('%s rows exceeds the %s row maximum', jsonb_array_length(v_rows), v_max_rows));
  end if;

  -- Idempotency: same model, same payload, same answer (with duplicate:true).
  -- The advisory lock serializes concurrent identical submissions so the
  -- loser sees the winner's row here instead of a unique violation later.
  v_hash := md5(coalesce(p_envelope->>'idempotency_key', v_rows::text || v_origin::text || v_season::text));
  if not p_dry then
    perform pg_advisory_xact_lock(hashtext(v_model_id::text || ':' || v_hash));
    select * into v_existing from collective.submissions
     where model_id = v_model_id and payload_hash = v_hash;
    if found then
      return coalesce(v_existing.response, '{}'::jsonb) || jsonb_build_object('ok', true, 'duplicate', true);
    end if;
  end if;

  v_sub_id := gen_random_uuid();

  for row_j in select * from jsonb_array_elements(v_rows) loop
    v_status := null; v_reason := null; v_game := null; v_late := false; v_candidate := false;

    -- Field validation. A rejected row is reported, never stored.
    if coalesce(row_j->>'game_ref','') = '' or coalesce(row_j->>'home_team','') = ''
       or coalesce(row_j->>'away_team','') = '' or coalesce(row_j->>'kickoff','') = '' then
      v_status := 'rejected'; v_reason := 'game_ref, home_team, away_team, and kickoff are required';
    end if;
    if v_status is null then
      begin
        v_kick := (row_j->>'kickoff')::timestamptz;
      exception when others then
        v_status := 'rejected'; v_reason := 'kickoff is not a valid timestamp';
      end;
    end if;
    if v_status is null then
      -- Every optional field parses inside this block: a bad value rejects
      -- THIS row only and can never abort the whole submission.
      begin
        v_hwp   := nullif(row_j->>'home_win_probability','')::numeric;
        v_spread:= nullif(row_j->>'projected_spread','')::numeric;
        v_cover := nullif(row_j->>'cover_probability','')::numeric;
        v_line  := nullif(row_j->>'line_at_submission','')::numeric;
        v_ptot  := nullif(row_j->>'projected_total','')::numeric;
        v_phs   := nullif(row_j->>'proj_home_score','')::numeric;
        v_pas   := nullif(row_j->>'proj_away_score','')::numeric;
        v_conf  := nullif(row_j->>'confidence','')::numeric;
        v_pick  := nullif(row_j->>'pick_side','')::collective.pick_side;
        v_tside := nullif(row_j->>'total_side','')::collective.total_side;
        v_week  := coalesce(nullif(row_j->>'week','')::int, v_env_week);
        if v_hwp is not null and (v_hwp < 0 or v_hwp > 1) then
          v_status := 'rejected'; v_reason := 'home_win_probability must be between 0 and 1';
        elsif v_cover is not null and (v_cover < 0 or v_cover > 1) then
          v_status := 'rejected'; v_reason := 'cover_probability must be between 0 and 1';
        elsif v_cover is not null and v_line is null then
          -- A pick probability is meaningless without its line (9.3).
          v_status := 'rejected'; v_reason := 'cover_probability requires line_at_submission';
        elsif v_hwp is not null and v_spread is not null and
              ((v_hwp > 0.5 and v_spread > 3) or (v_hwp < 0.5 and v_spread < -3)) then
          -- Win probability is not spread probability (9.2): an obvious
          -- contradiction is a mapping error and gets rejected loudly.
          v_status := 'rejected';
          v_reason := 'home_win_probability contradicts projected_spread; check that the probability is moneyline and the spread is home convention';
        end if;
      exception when others then
        v_status := 'rejected'; v_reason := 'a field failed to parse; check number formats and pick_side/total_side values';
      end;
    end if;

    if v_status is null then
      v_game := collective.resolve_game_ref(v_sport, v_season, row_j->>'home_team', row_j->>'away_team', v_kick);
      if v_game is null then
        v_status := 'quarantined';
        if collective.resolve_team(v_sport, row_j->>'home_team') is null then v_reason := 'unknown_team_home';
        elsif collective.resolve_team(v_sport, row_j->>'away_team') is null then v_reason := 'unknown_team_away';
        else v_reason := 'unknown_game'; end if;
        n_quar := n_quar + 1;
      else
        select v_received > g.kickoff_at into v_late from collective.games g where g.id = v_game;
        if v_late then
          -- Stored, flagged, excluded from grading (8.6).
          v_status := 'late'; n_late := n_late + 1;
        else
          v_status := 'resolved'; n_res := n_res + 1;
        end if;
        v_candidate := (not v_late) and v_origin = 'live'
          and not exists (select 1 from collective.projections px
                          where px.model_id = v_model_id and px.game_id = v_game and px.is_graded_candidate);
        if v_status = 'resolved' then
          if v_candidate then n_first := n_first + 1; else n_move := n_move + 1; end if;
        end if;
      end if;
    else
      n_rej := n_rej + 1;
    end if;

    if not p_dry and v_status <> 'rejected' then
      begin
        insert into collective.projections (
          submission_id, model_id, game_id, raw_game_ref, raw_row,
          resolution_status, quarantine_reason, sport_code, season, week,
          pick_side, total_side, line_at_submission, projected_spread, projected_total,
          proj_home_score, proj_away_score, home_win_prob, cover_prob, confidence,
          data_origin, received_at, is_late, is_graded_candidate)
        values (
          v_sub_id, v_model_id, v_game, row_j->>'game_ref', row_j,
          case when v_status = 'quarantined' then 'quarantined' else 'resolved' end::collective.resolution_status,
          case when v_status = 'quarantined' then v_reason end,
          v_sport, v_season, v_week,
          v_pick, v_tside, v_line, v_spread, v_ptot, v_phs, v_pas,
          v_hwp, v_cover, v_conf,
          v_origin, v_received, coalesce(v_late, false), v_candidate);
      exception when unique_violation then
        -- Concurrent first-lock race: the index is the law, this row
        -- becomes movement.
        insert into collective.projections (
          submission_id, model_id, game_id, raw_game_ref, raw_row,
          resolution_status, quarantine_reason, sport_code, season, week,
          pick_side, total_side, line_at_submission, projected_spread, projected_total,
          proj_home_score, proj_away_score, home_win_prob, cover_prob, confidence,
          data_origin, received_at, is_late, is_graded_candidate)
        values (
          v_sub_id, v_model_id, v_game, row_j->>'game_ref', row_j,
          'resolved', null, v_sport, v_season, v_week,
          v_pick, v_tside, v_line, v_spread, v_ptot, v_phs, v_pas,
          v_hwp, v_cover, v_conf,
          v_origin, v_received, coalesce(v_late, false), false);
        if v_candidate then n_first := n_first - 1; n_move := n_move + 1; v_candidate := false; end if;
      end;
    end if;

    v_out := v_out || jsonb_build_object(
      'game_ref', row_j->>'game_ref',
      'status', v_status,
      'game_id', v_game,
      'reason', v_reason);
  end loop;

  v_resp := jsonb_build_object(
    'ok', true,
    'submission_id', case when p_dry then null else v_sub_id::text end,
    'received_at', v_received,
    'data_origin', v_origin,
    'counts', jsonb_build_object(
      'rows', jsonb_array_length(v_rows), 'resolved', n_res + n_late, 'quarantined', n_quar,
      'late', n_late, 'first', n_first, 'movement', n_move, 'rejected', n_rej),
    'rows', v_out,
    'duplicate', false);

  if not p_dry then
    insert into collective.submissions (id, model_id, api_key_id, received_at, data_origin,
      client_generated_at, payload_hash, n_rows, n_resolved, n_quarantined, n_late, response)
    values (v_sub_id, v_model_id, v_key_id, v_received, v_origin,
      v_gen, v_hash,
      jsonb_array_length(v_rows), n_res + n_late, n_quar, n_late, v_resp);
  end if;

  return v_resp;
end $$;

-- ---------------------------------------------------------------- invites

create or replace function collective.mint_invite(
  p_admin uuid, p_prefill jsonb, p_founding boolean, p_share_bps int,
  p_max_uses int, p_note text, p_token_hash text, p_token_prefix text
) returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  v_days int := collective.cfg_int('invite.expiry_days', 30);
  v_id uuid;
  v_exp timestamptz;
begin
  if not collective.is_admin(p_admin) then
    return jsonb_build_object('ok', false, 'code', 'forbidden', 'message', 'Not an admin account');
  end if;
  v_exp := now() + make_interval(days => v_days);
  insert into collective.invite_tokens (token_hash, token_prefix, prefill, founding_member, referral_share_bps, max_uses, note, created_by, expires_at)
  values (p_token_hash, p_token_prefix, coalesce(p_prefill, '{}'::jsonb), coalesce(p_founding, false),
          p_share_bps, greatest(coalesce(p_max_uses, 1), 1), p_note, p_admin, v_exp)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'invite_id', v_id, 'expires_at', v_exp);
end $$;

create or replace function collective.invite_status(p_token_hash text) returns jsonb
language plpgsql stable security definer set search_path = collective as $$
declare
  t record;
begin
  select * into t from collective.invite_tokens where token_hash = p_token_hash;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'token_invalid', 'message', 'No such invite');
  end if;
  -- Dead tokens leak no invitee details: no prefill on these branches.
  if t.expires_at < now() then
    return jsonb_build_object('ok', true, 'status', 'expired', 'founding', t.founding_member,
      'prefill', '{}'::jsonb, 'expires_at', t.expires_at);
  end if;
  if t.use_count >= t.max_uses then
    return jsonb_build_object('ok', true, 'status', 'spent', 'founding', t.founding_member,
      'prefill', '{}'::jsonb, 'expires_at', t.expires_at);
  end if;
  return jsonb_build_object('ok', true, 'status', 'valid', 'founding', t.founding_member,
    'prefill', t.prefill, 'expires_at', t.expires_at);
end $$;

create or replace function collective.redeem_invite(
  p_token_hash text, p_user_id uuid, p_email text, p_profile jsonb,
  p_key_prefix text, p_key_hash text
) returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  t record;
  c record;
  v_creator_id uuid;
  v_model_id uuid;
  v_slug text;
  v_model_slug text;
  v_share int;
  v_host text;
  i int := 2;
begin
  select * into t from collective.invite_tokens where token_hash = p_token_hash for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'token_invalid', 'message', 'No such invite');
  end if;

  -- Idempotent per user: re-opening screen 3 must not burn the token or
  -- mint a second identity.
  select cr.*, m.slug as mslug, m.name as mname, m.sport_code as msport
  into c
  from collective.creators cr
  left join collective.models m on m.creator_id = cr.id
  where cr.user_id = p_user_id
  order by m.created_at limit 1;
  if found then
    return jsonb_build_object('ok', true, 'already_issued', true,
      'creator_id', c.id, 'creator_slug', c.slug, 'display_name', c.display_name,
      'founding', c.founding_member,
      'model_slug', c.mslug, 'model_name', c.mname, 'sport', c.msport);
  end if;

  if t.expires_at < now() then
    return jsonb_build_object('ok', false, 'code', 'token_expired', 'message', 'This invite has expired');
  end if;
  if t.use_count >= t.max_uses then
    return jsonb_build_object('ok', false, 'code', 'token_spent', 'message', 'This invite has already been used');
  end if;

  v_slug := collective.slugify(p_profile->>'display_name');
  while exists (select 1 from collective.creators where slug = v_slug) loop
    -- keep the disambiguated slug inside the 40-char constraint
    v_slug := left(collective.slugify(p_profile->>'display_name'), 40 - length(i::text) - 1) || '-' || i;
    i := i + 1;
  end loop;
  v_share := coalesce(t.referral_share_bps,
    case when t.founding_member
      then collective.cfg_int('share.founding_bps', 5000)
      else collective.cfg_int('share.referral_bps_default', 4000) end);

  insert into collective.creators (user_id, slug, display_name, description, website_url, x_handle, logo_url,
    founding_member, referral_share_bps, invite_token_id)
  values (p_user_id, v_slug, p_profile->>'display_name',
    nullif(p_profile->>'description',''), nullif(p_profile->>'website_url',''),
    nullif(p_profile->>'x_handle',''), nullif(p_profile->>'logo_url',''),
    t.founding_member, v_share, t.id)
  returning id into v_creator_id;

  v_model_slug := collective.slugify(p_profile->>'model_name');
  insert into collective.models (creator_id, slug, name, sport_code)
  values (v_creator_id, v_model_slug, p_profile->>'model_name', p_profile->>'sport')
  returning id into v_model_id;

  insert into collective.api_keys (creator_id, model_id, kind, key_prefix, key_hash)
  values (v_creator_id, v_model_id, 'live', p_key_prefix, p_key_hash);

  -- Their own site is allowlisted for the embed from the moment they join.
  if nullif(p_profile->>'website_url','') is not null then
    begin
      v_host := lower(regexp_replace(p_profile->>'website_url', '^(https?://[^/]+).*$', '\1'));
      if v_host like 'http%' then
        insert into collective.embed_installs (creator_id, origin) values (v_creator_id, v_host)
        on conflict do nothing;
      end if;
    exception when others then null; end;
  end if;

  update collective.invite_tokens set use_count = use_count + 1 where id = t.id;

  return jsonb_build_object('ok', true, 'already_issued', false,
    'creator_id', v_creator_id, 'creator_slug', v_slug,
    'display_name', p_profile->>'display_name', 'founding', t.founding_member,
    'model_id', v_model_id, 'model_slug', v_model_slug,
    'model_name', p_profile->>'model_name', 'sport', p_profile->>'sport');
end $$;

create or replace function collective.join_request(p_email text, p_note text, p_token text) returns jsonb
language plpgsql security definer set search_path = collective as $$
begin
  insert into collective.join_requests (email, note, token_seen) values (p_email, p_note, left(coalesce(p_token,''), 16));
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- quarantine

create or replace function collective.admin_resolve_quarantine(p_projection_id uuid, p_game_id uuid) returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  p record;
  v_kick timestamptz;
  v_late boolean;
  v_candidate boolean;
begin
  select * into p from collective.projections where id = p_projection_id and resolution_status = 'quarantined';
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'No quarantined row with that id');
  end if;
  select kickoff_at into v_kick from collective.games where id = p_game_id;
  if v_kick is null then
    return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'No such game');
  end if;
  v_late := p.received_at > v_kick;
  v_candidate := (not v_late) and p.data_origin = 'live'
    and not exists (select 1 from collective.projections px
                    where px.model_id = p.model_id and px.game_id = p_game_id and px.is_graded_candidate);
  -- The service maintenance path (rule 8.3): the only sanctioned mutation,
  -- and it may touch resolution fields only.
  perform set_config('collective.maintenance', 'on', true);
  update collective.projections
     set game_id = p_game_id, resolution_status = 'resolved', quarantine_reason = null,
         is_late = v_late, is_graded_candidate = v_candidate
   where id = p_projection_id;
  perform set_config('collective.maintenance', '', true);
  -- If the game already settled, grade the newly resolved row now.
  if exists (select 1 from collective.results where game_id = p_game_id) then
    perform collective.grade_game(p_game_id);
  end if;
  return jsonb_build_object('ok', true, 'resolved', 1, 'late', v_late, 'graded_candidate', v_candidate);
end $$;

-- After teaching the resolver a new alias: retry every quarantined row that
-- now resolves.
create or replace function collective.admin_reresolve(p_sport text) returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  q record;
  v_game uuid;
  v_n int := 0;
  r jsonb;
begin
  for q in select p.id, p.season, p.raw_row from collective.projections p
           where p.resolution_status = 'quarantined' and p.sport_code = p_sport loop
    v_game := collective.resolve_game_ref(p_sport, q.season,
      q.raw_row->>'home_team', q.raw_row->>'away_team',
      nullif(q.raw_row->>'kickoff','')::timestamptz);
    if v_game is not null then
      r := collective.admin_resolve_quarantine(q.id, v_game);
      if coalesce((r->>'ok')::boolean, false) then v_n := v_n + 1; end if;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'resolved', v_n);
end $$;

-- ---------------------------------------------------------------- attribution

create or replace function collective.record_touch(p_visitor text, p_creator_slug text, p_source text, p_origin text) returns void
language plpgsql security definer set search_path = collective as $$
declare
  v_creator uuid;
begin
  if coalesce(p_visitor, '') = '' then return; end if;
  select id into v_creator from collective.creators where slug = p_creator_slug and status = 'active';
  if v_creator is null then return; end if;
  -- First touch wins and is never overwritten (Section 5).
  if exists (select 1 from collective.attribution_touches where visitor_id = p_visitor) then return; end if;
  insert into collective.attribution_touches (visitor_id, creator_id, source, origin)
  values (p_visitor, v_creator, case when p_source in ('embed','link') then p_source else 'link' end, p_origin);
end $$;

create or replace function collective.lock_attribution(
  p_user_id uuid, p_email_hash text, p_visitor text, p_ref_slug text
) returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  v_creator uuid;
  v_source text := 'link';
  v_id uuid;
begin
  -- Locked at conversion, never moves. If a lock already exists it stands.
  select id, creator_id into v_id, v_creator from collective.attributions
   where (p_user_id is not null and subscriber_user_id = p_user_id)
      or (p_email_hash is not null and subscriber_email_hash = p_email_hash)
   limit 1;
  if v_id is not null then
    return jsonb_build_object('ok', true, 'attribution_id', v_id, 'creator_id', v_creator, 'existing', true);
  end if;

  -- Earliest recorded touch for this visitor wins; the checkout ref slug is
  -- the fallback when no touch was captured.
  select creator_id, source into v_creator, v_source
  from collective.attribution_touches
  where visitor_id = p_visitor and p_visitor is not null and p_visitor <> ''
  order by touched_at asc limit 1;

  if v_creator is null and coalesce(p_ref_slug, '') <> '' then
    select id into v_creator from collective.creators where slug = p_ref_slug and status = 'active';
  end if;
  if v_creator is null then
    return jsonb_build_object('ok', true, 'attribution_id', null, 'creator_id', null, 'existing', false);
  end if;

  insert into collective.attributions (subscriber_user_id, subscriber_email_hash, creator_id, visitor_id, source)
  values (p_user_id, p_email_hash, v_creator, p_visitor, v_source)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'attribution_id', v_id, 'creator_id', v_creator, 'existing', false);
end $$;

-- ---------------------------------------------------------------- billing

create or replace function collective.billing_upsert_subscriber(p_event jsonb) returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  v_id uuid;
  v_attr jsonb;
begin
  v_attr := collective.lock_attribution(
    nullif(p_event->>'user_id','')::uuid,
    nullif(p_event->>'email_hash',''),
    nullif(p_event->>'visitor',''),
    nullif(p_event->>'ref_slug',''));

  begin
    insert into collective.subscribers (user_id, email, status, plan, stripe_customer_id, stripe_subscription_id, attribution_id, current_period_end)
    values (
      nullif(p_event->>'user_id','')::uuid,
      nullif(p_event->>'email',''),
      coalesce(nullif(p_event->>'status',''), 'active')::collective.sub_status,
      nullif(p_event->>'plan',''),
      nullif(p_event->>'stripe_customer_id',''),
      nullif(p_event->>'stripe_subscription_id',''),
      nullif(v_attr->>'attribution_id','')::uuid,
      nullif(p_event->>'current_period_end','')::timestamptz)
    on conflict (stripe_subscription_id) do update
      set status = excluded.status,
          plan = coalesce(excluded.plan, collective.subscribers.plan),
          current_period_end = coalesce(excluded.current_period_end, collective.subscribers.current_period_end),
          canceled_at = case when excluded.status = 'canceled' then now() else collective.subscribers.canceled_at end
    returning id into v_id;
  exception when unique_violation then
    -- A returning subscriber: same user, a NEW Stripe subscription id.
    -- Update their row in place so the paying user regains entitlement and
    -- the original creator keeps the referral (attribution never moves).
    update collective.subscribers
       set stripe_subscription_id = nullif(p_event->>'stripe_subscription_id',''),
           stripe_customer_id = coalesce(nullif(p_event->>'stripe_customer_id',''), stripe_customer_id),
           status = coalesce(nullif(p_event->>'status',''), 'active')::collective.sub_status,
           plan = coalesce(nullif(p_event->>'plan',''), plan),
           current_period_end = coalesce(nullif(p_event->>'current_period_end','')::timestamptz, current_period_end),
           canceled_at = null
     where user_id = nullif(p_event->>'user_id','')::uuid
     returning id into v_id;
  end;
  return jsonb_build_object('ok', true, 'subscriber_id', v_id,
    'creator_id', v_attr->>'creator_id');
end $$;

create or replace function collective.billing_post_invoice(p jsonb) returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  s record;
  v_share int;
  v_amount int := coalesce(nullif(p->>'amount_cents','')::int, 0);
  v_month date := coalesce(nullif(p->>'period_month','')::date, date_trunc('month', now())::date);
  v_net int := collective.cfg_int('payout.net_days', 30);
  v_cents int;
begin
  select sub.id as subscriber_id, a.creator_id, c.referral_share_bps
  into s
  from collective.subscribers sub
  join collective.attributions a on a.id = sub.attribution_id
  join collective.creators c on c.id = a.creator_id
  where sub.stripe_subscription_id = p->>'stripe_subscription_id';
  if not found then
    return jsonb_build_object('ok', true, 'posted', false, 'reason', 'no attributed creator');
  end if;
  v_cents := (v_amount * s.referral_share_bps) / 10000;
  insert into collective.earnings_ledger (creator_id, subscriber_id, entry_type, amount_cents, period_month, available_at, stripe_ref, note)
  values (s.creator_id, s.subscriber_id, 'earning', v_cents, v_month,
          (v_month + interval '1 month') + make_interval(days => v_net),
          nullif(p->>'stripe_ref',''), p->>'note')
  on conflict (stripe_ref) where entry_type = 'earning' and stripe_ref is not null do nothing;
  return jsonb_build_object('ok', true, 'posted', true, 'creator_id', s.creator_id, 'amount_cents', v_cents);
end $$;

create or replace function collective.billing_post_refund(p jsonb) returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  e record;
  v_window int := collective.cfg_int('payout.clawback_days', 60);
begin
  select * into e from collective.earnings_ledger
   where entry_type = 'earning' and stripe_ref = p->>'stripe_ref';
  if not found then
    return jsonb_build_object('ok', true, 'posted', false, 'reason', 'no matching earning');
  end if;
  if e.created_at < now() - make_interval(days => v_window) then
    return jsonb_build_object('ok', true, 'posted', false, 'reason', 'outside the clawback window');
  end if;
  -- Stripe retries webhooks: one clawback per refund, ever. The clawback
  -- carries the SAME available_at as the earning it reverses so the pair
  -- always nets to zero in available_cents.
  if exists (select 1 from collective.earnings_ledger
             where entry_type = 'clawback' and stripe_ref = p->>'stripe_ref') then
    return jsonb_build_object('ok', true, 'posted', false, 'reason', 'already clawed back');
  end if;
  insert into collective.earnings_ledger (creator_id, subscriber_id, entry_type, amount_cents, period_month, available_at, stripe_ref, note)
  values (e.creator_id, e.subscriber_id, 'clawback', -e.amount_cents, e.period_month, e.available_at,
          p->>'stripe_ref', 'refund or chargeback clawback')
  on conflict (stripe_ref) where entry_type = 'clawback' and stripe_ref is not null do nothing;
  return jsonb_build_object('ok', true, 'posted', true, 'amount_cents', -e.amount_cents);
end $$;

-- ---------------------------------------------------------------- grants

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'collective'
  loop
    execute format('revoke execute on function %s from public', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

-- ============================================================
-- 20260819000008_collective_seeds.sql
-- ============================================================
-- Model Collective, migration 8: seeds. Config numbers (Section 5, decided,
-- one place only), the NFL, its 2026 season window, all 32 teams, and a
-- generous alias vocabulary for canonical resolution.

insert into collective.config (key, value, description) values
  ('pricing.monthly_cents',      '2499',  'Retail price, fixed everywhere: $24.99 per month'),
  ('pricing.annual_cents',       '0',     'Annual plan disabled: monthly only'),
  ('share.referral_bps_default', '4000',  'Mode A default: 40 percent recurring'),
  ('share.founding_bps',         '5000',  'Founding member Mode A rate: 50 percent recurring, locked for membership life'),
  ('share.founding_seats',       '10',    'How many founding invitations exist'),
  ('wholesale.seat_cents',       '1400',  'Mode B: $14 per seat per month'),
  ('wholesale.min_seats',        '10',    'Mode B minimum seats'),
  ('wholesale.floor_cents',      '2000',  'Mode B may not sell standalone below this; bundle only'),
  ('payout.min_cents',           '5000',  '$50 payout minimum, balance rolls forward'),
  ('payout.net_days',            '30',    'Monthly payouts, net 30 after month close'),
  ('payout.clawback_days',       '60',    'Refund and chargeback clawback window'),
  ('ranking.min_coverage_pct',   '60',    'Minimum season-to-date slate coverage to be ranked'),
  ('ranking.min_graded_games',   '20',    'Minimum graded games to be ranked'),
  ('ranking.per_sport',          '{}',    'Optional per-sport overrides of the ranking minimums'),
  ('status.active_days',         '10',    'Live submission within this many days = ACTIVE CONTRIBUTOR in season'),
  ('status.inactive_days',       '45',    'Silence this long in season = INACTIVE'),
  ('billing.enabled',            'false', 'Money switch. Attribution records either way (rule 8.13)'),
  ('invite.expiry_days',         '30',    'Invite tokens live this long'),
  ('ingest.max_rows',            '500',   'Rows per submission'),
  ('ingest.max_bytes',           '524288','Bytes per submission body'),
  ('ingest.rate_per_hour',       '60',    'Requests per key per hour'),
  ('admin.user_ids',             '[]',    'Auth user ids allowed on collective_admin endpoints'),
  ('embed.cache_seconds',        '60',    'Embed bootstrap cache TTL'),
  ('embed.allow_localhost',      'true',  'Allow localhost origins for embed testing');

insert into collective.sports (code, name) values ('NFL', 'Football');
insert into collective.sport_seasons (sport_code, season, starts_on, ends_on)
values ('NFL', 2026, '2026-09-04', '2027-02-08');

-- Teams plus aliases. Format: code | city | nickname | extra;extra.
-- Every team answers to its code, nickname, and full name. City aliases are
-- seeded only where unambiguous (New York and Los Angeles are not).
do $$
declare
  rows text[] := array[
    'ARI|Arizona|Cardinals|ARZ;AZ',
    'ATL|Atlanta|Falcons|',
    'BAL|Baltimore|Ravens|BLT',
    'BUF|Buffalo|Bills|',
    'CAR|Carolina|Panthers|',
    'CHI|Chicago|Bears|',
    'CIN|Cincinnati|Bengals|',
    'CLE|Cleveland|Browns|CLV',
    'DAL|Dallas|Cowboys|',
    'DEN|Denver|Broncos|',
    'DET|Detroit|Lions|',
    'GB|Green Bay|Packers|GNB',
    'HOU|Houston|Texans|',
    'IND|Indianapolis|Colts|',
    'JAX|Jacksonville|Jaguars|JAC',
    'KC|Kansas City|Chiefs|KAN',
    'LAC|Los Angeles|Chargers|SD;San Diego Chargers',
    'LAR|Los Angeles|Rams|LA;STL;St. Louis Rams',
    'LV|Las Vegas|Raiders|OAK;Oakland Raiders',
    'MIA|Miami|Dolphins|',
    'MIN|Minnesota|Vikings|',
    'NE|New England|Patriots|NWE',
    'NO|New Orleans|Saints|NOR',
    'NYG|New York|Giants|',
    'NYJ|New York|Jets|',
    'PHI|Philadelphia|Eagles|',
    'PIT|Pittsburgh|Steelers|',
    'SEA|Seattle|Seahawks|',
    'SF|San Francisco|49ers|SFO;Niners',
    'TB|Tampa Bay|Buccaneers|TAM;Bucs',
    'TEN|Tennessee|Titans|TENN',
    'WAS|Washington|Commanders|WSH;Washington Football Team'
  ];
  r text;
  parts text[];
  v_team uuid;
  a text;
  city_ambiguous boolean;
begin
  foreach r in array rows loop
    parts := string_to_array(r, '|');
    insert into collective.teams (sport_code, code, name)
    values ('NFL', parts[1], parts[2] || ' ' || parts[3])
    returning id into v_team;

    -- code, nickname, full name
    insert into collective.team_aliases (sport_code, alias, team_id) values
      ('NFL', parts[1], v_team),
      ('NFL', parts[3], v_team),
      ('NFL', parts[2] || ' ' || parts[3], v_team);

    -- city alias where it is unambiguous
    city_ambiguous := parts[2] in ('New York', 'Los Angeles');
    if not city_ambiguous then
      insert into collective.team_aliases (sport_code, alias, team_id)
      values ('NFL', parts[2], v_team)
      on conflict do nothing;
    end if;

    if parts[4] <> '' then
      foreach a in array string_to_array(parts[4], ';') loop
        insert into collective.team_aliases (sport_code, alias, team_id)
        values ('NFL', a, v_team)
        on conflict do nothing;
      end loop;
    end if;
  end loop;
end $$;

-- ============================================================
-- 20260820000009_collective_econ_invites.sql
-- ============================================================
-- Model Collective, migration 9: the economics waterfall, invite revocation,
-- and model sources.
--
-- Owner decision 2026-08-20: creator compensation is no longer a referral
-- percentage. Gross Collective revenue splits 10% operating reserve, 30%
-- platform, 60% Founding Collective Pool divided equally across the founding
-- seats. Referral remains in the architecture as a SEPARATE customer
-- acquisition concept, 0% by default, and never dilutes the founder pool.
-- All numbers live in config; nothing here is hard-coded into pages.

-- ------------------------------------------------------------ 1) economics
insert into collective.config (key, value, description) values
  ('econ.reserve_bps',      '1000', 'Operating reserve share of gross Collective revenue'),
  ('econ.platform_bps',     '3000', 'Platform and operator allocation of gross Collective revenue'),
  ('econ.founder_pool_bps', '6000', 'Founding Collective Pool, divided equally across the founding seats'),
  ('econ.founder_count',    '6',    'Founding seats the pool divides across'),
  ('econ.referral_bps',     '0',    'Referral share for customer acquisition, separate from founder economics, off by default')
on conflict (key) do nothing;

-- Retire the referral-as-compensation model everywhere it was stored so no
-- conflicting numbers survive (a 50%/40% referral share next to a founder
-- pool would be two comp systems). Founding identity keeps living on
-- creators.founding_member; the money now flows from config at post time.
update collective.config
   set value = '0',
       description = 'Legacy referral default, superseded by econ.referral_bps'
 where key = 'share.referral_bps_default';
update collective.config
   set description = 'Legacy founding referral share, superseded by the founder pool (econ.*)'
 where key = 'share.founding_bps';
update collective.creators set referral_share_bps = 0;

-- ------------------------------------------------------ 2) invite lifecycle
alter table collective.invite_tokens add column if not exists revoked_at timestamptz;

-- ------------------------------------------------------- 3) model sources
-- Where the model lives: spreadsheet, GitHub repo, hosted app, or other.
-- The admin picks the type at invite time; the creator completes the detail
-- during onboarding. Both are optional forever: a model with no declared
-- source still submits through the same pipeline.
alter table collective.models add column if not exists source_kind text
  check (source_kind is null or source_kind in ('excel','github','online','other'));
alter table collective.models add column if not exists source_ref text;

-- ------------------------------------------------------------- 4) RPCs

-- Revoke an invite: the link stops working immediately, nothing else changes.
create or replace function collective.revoke_invite(p_admin uuid, p_invite_id uuid) returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  t record;
begin
  if not collective.is_admin(p_admin) then
    return jsonb_build_object('ok', false, 'code', 'forbidden', 'message', 'Not an admin account');
  end if;
  select * into t from collective.invite_tokens where id = p_invite_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'No such invite');
  end if;
  if t.revoked_at is not null then
    return jsonb_build_object('ok', true, 'already_revoked', true);
  end if;
  update collective.invite_tokens set revoked_at = now() where id = p_invite_id;
  return jsonb_build_object('ok', true, 'already_revoked', false);
end $$;

create or replace function collective.invite_status(p_token_hash text) returns jsonb
language plpgsql stable security definer set search_path = collective as $$
declare
  t record;
begin
  select * into t from collective.invite_tokens where token_hash = p_token_hash;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'token_invalid', 'message', 'No such invite');
  end if;
  -- Dead tokens leak no invitee details: no prefill on these branches.
  if t.revoked_at is not null then
    return jsonb_build_object('ok', true, 'status', 'revoked', 'founding', t.founding_member,
      'prefill', '{}'::jsonb, 'expires_at', t.expires_at);
  end if;
  if t.expires_at < now() then
    return jsonb_build_object('ok', true, 'status', 'expired', 'founding', t.founding_member,
      'prefill', '{}'::jsonb, 'expires_at', t.expires_at);
  end if;
  if t.use_count >= t.max_uses then
    return jsonb_build_object('ok', true, 'status', 'spent', 'founding', t.founding_member,
      'prefill', '{}'::jsonb, 'expires_at', t.expires_at);
  end if;
  return jsonb_build_object('ok', true, 'status', 'valid', 'founding', t.founding_member,
    'prefill', t.prefill, 'expires_at', t.expires_at);
end $$;

create or replace function collective.redeem_invite(
  p_token_hash text, p_user_id uuid, p_email text, p_profile jsonb,
  p_key_prefix text, p_key_hash text
) returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  t record;
  c record;
  v_creator_id uuid;
  v_model_id uuid;
  v_slug text;
  v_model_slug text;
  v_share int;
  v_host text;
  v_src_kind text;
  i int := 2;
begin
  select * into t from collective.invite_tokens where token_hash = p_token_hash for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'token_invalid', 'message', 'No such invite');
  end if;

  -- Idempotent per user: re-opening screen 3 must not burn the token or
  -- mint a second identity.
  select cr.*, m.slug as mslug, m.name as mname, m.sport_code as msport
  into c
  from collective.creators cr
  left join collective.models m on m.creator_id = cr.id
  where cr.user_id = p_user_id
  order by m.created_at limit 1;
  if found then
    return jsonb_build_object('ok', true, 'already_issued', true,
      'creator_id', c.id, 'creator_slug', c.slug, 'display_name', c.display_name,
      'founding', c.founding_member,
      'model_slug', c.mslug, 'model_name', c.mname, 'sport', c.msport);
  end if;

  if t.revoked_at is not null then
    return jsonb_build_object('ok', false, 'code', 'token_revoked', 'message', 'This invite was revoked');
  end if;
  if t.expires_at < now() then
    return jsonb_build_object('ok', false, 'code', 'token_expired', 'message', 'This invite has expired');
  end if;
  if t.use_count >= t.max_uses then
    return jsonb_build_object('ok', false, 'code', 'token_spent', 'message', 'This invite has already been used');
  end if;

  v_slug := collective.slugify(p_profile->>'display_name');
  while exists (select 1 from collective.creators where slug = v_slug) loop
    -- keep the disambiguated slug inside the 40-char constraint
    v_slug := left(collective.slugify(p_profile->>'display_name'), 40 - length(i::text) - 1) || '-' || i;
    i := i + 1;
  end loop;

  -- Compensation is the founder pool (config, computed at post time), never a
  -- per-creator percentage. referral_share_bps now only carries the separate
  -- referral acquisition share, which defaults to 0.
  v_share := coalesce(t.referral_share_bps, collective.cfg_int('econ.referral_bps', 0));

  insert into collective.creators (user_id, slug, display_name, description, website_url, x_handle, logo_url,
    founding_member, referral_share_bps, invite_token_id)
  values (p_user_id, v_slug, p_profile->>'display_name',
    nullif(p_profile->>'description',''), nullif(p_profile->>'website_url',''),
    nullif(p_profile->>'x_handle',''), nullif(p_profile->>'logo_url',''),
    t.founding_member, v_share, t.id)
  returning id into v_creator_id;

  v_src_kind := case when p_profile->>'source_kind' in ('excel','github','online','other')
                     then p_profile->>'source_kind' end;
  v_model_slug := collective.slugify(p_profile->>'model_name');
  insert into collective.models (creator_id, slug, name, sport_code, source_kind, source_ref)
  values (v_creator_id, v_model_slug, p_profile->>'model_name', p_profile->>'sport',
          v_src_kind, nullif(left(coalesce(p_profile->>'source_ref',''), 300), ''))
  returning id into v_model_id;

  insert into collective.api_keys (creator_id, model_id, kind, key_prefix, key_hash)
  values (v_creator_id, v_model_id, 'live', p_key_prefix, p_key_hash);

  -- Their own site is allowlisted for the embed from the moment they join.
  if nullif(p_profile->>'website_url','') is not null then
    begin
      v_host := lower(regexp_replace(p_profile->>'website_url', '^(https?://[^/]+).*$', '\1'));
      if v_host like 'http%' then
        insert into collective.embed_installs (creator_id, origin) values (v_creator_id, v_host)
        on conflict do nothing;
      end if;
    exception when others then null; end;
  end if;

  update collective.invite_tokens set use_count = use_count + 1 where id = t.id;

  return jsonb_build_object('ok', true, 'already_issued', false,
    'creator_id', v_creator_id, 'creator_slug', v_slug,
    'display_name', p_profile->>'display_name', 'founding', t.founding_member,
    'model_id', v_model_id, 'model_slug', v_model_slug,
    'model_name', p_profile->>'model_name', 'sport', p_profile->>'sport');
end $$;

-- The revenue waterfall. On a paid invoice:
--   reserve and platform allocations stay with the Collective (no ledger row:
--   the ledger only tracks money owed to creators),
--   the founder pool share posts one equal earning per active founding member
--   (pool divided by econ.founder_count, the seat count, so each founding
--   member's share is fixed whether or not every seat is filled yet),
--   and the separate referral share posts to the attributed creator only when
--   econ.referral_bps is above zero.
-- Stripe retries webhooks, so the whole pass is idempotent per invoice ref.
-- Ledger refs are suffixed per entry ('#f-…', '#ref') because one invoice now
-- fans out to several rows and earnings_invoice_once is unique per ref.
create or replace function collective.billing_post_invoice(p jsonb) returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  f record;
  v_amount int := coalesce(nullif(p->>'amount_cents','')::int, 0);
  v_month date := coalesce(nullif(p->>'period_month','')::date, date_trunc('month', now())::date);
  v_net int := collective.cfg_int('payout.net_days', 30);
  v_ref_bps int := collective.cfg_int('econ.referral_bps', 0);
  v_pool_bps int := collective.cfg_int('econ.founder_pool_bps', 6000);
  v_fcount int := greatest(collective.cfg_int('econ.founder_count', 6), 1);
  v_base_ref text := nullif(p->>'stripe_ref','');
  v_sub_id uuid;
  v_ref_creator uuid;
  v_cents int;
  v_per_founder int;
  v_posted int := 0;
  v_total int := 0;
  v_avail timestamptz;
begin
  -- No ref, no post: without an invoice ref there is no idempotency and no
  -- clawback path, and Stripe always supplies one.
  if v_base_ref is null then
    return jsonb_build_object('ok', true, 'posted', false, 'reason', 'missing stripe_ref');
  end if;
  select id into v_sub_id from collective.subscribers
   where stripe_subscription_id = p->>'stripe_subscription_id';
  if v_sub_id is null then
    return jsonb_build_object('ok', true, 'posted', false, 'reason', 'no such subscriber');
  end if;
  v_avail := (v_month + interval '1 month') + make_interval(days => v_net);

  if exists (
    select 1 from collective.earnings_ledger
     where entry_type = 'earning'
       and (stripe_ref = v_base_ref or stripe_ref like v_base_ref || '#%')
  ) then
    return jsonb_build_object('ok', true, 'posted', false, 'reason', 'already posted');
  end if;

  -- Referral: customer acquisition, separate from founder economics. Never
  -- reduces the pool; off (0 bps) by default.
  if v_ref_bps > 0 then
    select a.creator_id into v_ref_creator
      from collective.subscribers sub
      join collective.attributions a on a.id = sub.attribution_id
     where sub.id = v_sub_id;
    v_cents := (v_amount * v_ref_bps) / 10000;
    if v_ref_creator is not null and v_cents > 0 then
      insert into collective.earnings_ledger
        (creator_id, subscriber_id, entry_type, amount_cents, period_month, available_at, stripe_ref, note)
      values (v_ref_creator, v_sub_id, 'earning', v_cents, v_month, v_avail,
              v_base_ref || '#ref', 'referral share')
      on conflict (stripe_ref) where entry_type = 'earning' and stripe_ref is not null do nothing;
      v_posted := v_posted + 1; v_total := v_total + v_cents;
    end if;
  end if;

  -- Founding Collective Pool: one equal share per founding seat.
  v_per_founder := ((v_amount * v_pool_bps) / 10000) / v_fcount;
  if v_per_founder > 0 then
    -- Capped at the configured seat count: even if more founding members ever
    -- exist than seats, the pool never pays out more than its share. The
    -- earliest-created members hold the seats, deterministically.
    for f in
      select id from collective.creators
       where founding_member and status = 'active'
       order by created_at
       limit v_fcount
    loop
      insert into collective.earnings_ledger
        (creator_id, subscriber_id, entry_type, amount_cents, period_month, available_at, stripe_ref, note)
      values (f.id, v_sub_id, 'earning', v_per_founder, v_month, v_avail,
              v_base_ref || '#f-' || left(f.id::text, 8), 'founder pool share')
      on conflict (stripe_ref) where entry_type = 'earning' and stripe_ref is not null do nothing;
      v_posted := v_posted + 1; v_total := v_total + v_per_founder;
    end loop;
  end if;

  return jsonb_build_object('ok', true, 'posted', v_posted > 0, 'entries', v_posted,
    'amount_cents', v_total, 'per_founder_cents', v_per_founder);
end $$;

-- A refund claws back every earning the invoice fanned out to, each exactly
-- once, inside the clawback window. Clawbacks reuse the earning's suffixed
-- ref so replays are blocked by earnings_clawback_once plus the exists guard.
create or replace function collective.billing_post_refund(p jsonb) returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  e record;
  v_window int := collective.cfg_int('payout.clawback_days', 60);
  v_ref text := nullif(p->>'stripe_ref','');
  v_posted int := 0;
  v_total int := 0;
begin
  if v_ref is null then
    return jsonb_build_object('ok', true, 'posted', false, 'reason', 'no stripe_ref');
  end if;
  for e in
    select * from collective.earnings_ledger
     where entry_type = 'earning'
       and (stripe_ref = v_ref or stripe_ref like v_ref || '#%')
  loop
    if e.created_at < now() - make_interval(days => v_window) then continue; end if;
    if exists (select 1 from collective.earnings_ledger
                where entry_type = 'clawback' and stripe_ref = e.stripe_ref) then
      continue;
    end if;
    -- The clawback carries the SAME available_at as the earning it reverses
    -- so the pair always nets to zero in available_cents.
    insert into collective.earnings_ledger
      (creator_id, subscriber_id, entry_type, amount_cents, period_month, available_at, stripe_ref, note)
    values (e.creator_id, e.subscriber_id, 'clawback', -e.amount_cents, e.period_month, e.available_at,
            e.stripe_ref, 'refund or chargeback clawback')
    on conflict (stripe_ref) where entry_type = 'clawback' and stripe_ref is not null do nothing;
    v_posted := v_posted + 1; v_total := v_total - e.amount_cents;
  end loop;
  if v_posted = 0 then
    return jsonb_build_object('ok', true, 'posted', false,
      'reason', 'no matching earning inside the clawback window');
  end if;
  return jsonb_build_object('ok', true, 'posted', true, 'entries', v_posted, 'amount_cents', v_total);
end $$;

-- ------------------------------------------------------------- 5) grants
-- Migration 7's grant sweep already ran; the one genuinely new function needs
-- the same treatment (create or replace preserves ACLs on the others).
revoke execute on function collective.revoke_invite(uuid, uuid) from public;
grant execute on function collective.revoke_invite(uuid, uuid) to service_role;

-- ============================================================
-- 20260820000010_collective_cfb.sql
-- ============================================================
-- Model Collective, migration 10: NCAA football (CFB).
--
-- Adds the sport, the 2026 season window, and all 136 FBS programs with
-- aliases. Team names follow CollegeFootballData spelling, which is what the
-- EdgeDesk cfb schema already ingests, so a creator submitting from CFD or
-- cfbfastR data resolves without translation. Common written variants (St for
-- State, "and" for &, parenthetical drops) are aliased too.
--
-- No games are seeded here: load a slate through Admin, Games, exactly like
-- NFL. Nothing about NFL changes.

insert into collective.sports (code, name) values ('CFB', 'College Football')
on conflict (code) do nothing;

insert into collective.sport_seasons (sport_code, season, starts_on, ends_on)
values ('CFB', 2026, '2026-08-22', '2027-01-20')
on conflict (sport_code, season) do nothing;

-- Format: code | school | extra;alias;variants
do $$
declare
  rows text[] := array[
    'AIRFORCE|Air Force|',
    'AKRON|Akron|',
    'ALABAMA|Alabama|',
    'APPSTATE|App State|App St;App St.;Appalachian St;Appalachian State',
    'ARIZONA|Arizona|',
    'ARIZONASTA|Arizona State|Arizona St;Arizona St.',
    'ARKANSAS|Arkansas|',
    'ARKANSASST|Arkansas State|Arkansas St;Arkansas St.',
    'ARMY|Army|',
    'AUBURN|Auburn|',
    'BYU|BYU|Brigham Young',
    'BALLSTATE|Ball State|Ball St;Ball St.',
    'BAYLOR|Baylor|',
    'BOISESTATE|Boise State|Boise St;Boise St.',
    'BOSTONCOLL|Boston College|',
    'BOWLINGGRE|Bowling Green|',
    'BUFFALO|Buffalo|',
    'CALIFORNIA|California|Cal',
    'CENTRALMIC|Central Michigan|',
    'CHARLOTTE|Charlotte|',
    'CINCINNATI|Cincinnati|',
    'CLEMSON|Clemson|',
    'COASTALCAR|Coastal Carolina|',
    'COLORADO|Colorado|',
    'COLORADOST|Colorado State|Colorado St;Colorado St.',
    'DELAWARE|Delaware|',
    'DUKE|Duke|',
    'EASTCAROLI|East Carolina|',
    'EASTERNMIC|Eastern Michigan|',
    'FLORIDA|Florida|',
    'FLORIDAATL|Florida Atlantic|FAU',
    'FLORIDAINT|Florida International|FIU',
    'FLORIDASTA|Florida State|Florida St;Florida St.',
    'FRESNOSTAT|Fresno State|Fresno St;Fresno St.',
    'GEORGIA|Georgia|',
    'GEORGIASOU|Georgia Southern|',
    'GEORGIASTA|Georgia State|Georgia St;Georgia St.',
    'GEORGIATEC|Georgia Tech|',
    'HAWAII|Hawai''i|Hawaii;Hawaii Rainbow Warriors',
    'HOUSTON|Houston|',
    'ILLINOIS|Illinois|',
    'INDIANA|Indiana|',
    'IOWA|Iowa|',
    'IOWASTATE|Iowa State|Iowa St;Iowa St.',
    'JACKSONVIL|Jacksonville State|Jacksonville St;Jacksonville St.',
    'JAMESMADIS|James Madison|',
    'KANSAS|Kansas|',
    'KANSASSTAT|Kansas State|Kansas St;Kansas St.',
    'KENNESAWST|Kennesaw State|Kennesaw St;Kennesaw St.',
    'KENTSTATE|Kent State|Kent St;Kent St.',
    'KENTUCKY|Kentucky|',
    'LSU|LSU|Louisiana State',
    'LIBERTY|Liberty|',
    'LOUISIANA|Louisiana|Louisiana Lafayette;Louisiana-Lafayette;UL Lafayette;ULL',
    'LOUISIANAT|Louisiana Tech|',
    'LOUISVILLE|Louisville|',
    'MARSHALL|Marshall|',
    'MARYLAND|Maryland|',
    'MASSACHUSE|Massachusetts|UMass',
    'MEMPHIS|Memphis|',
    'MIAMI|Miami|Miami (FL);Miami FL;Miami Florida',
    'MIAMIOH|Miami (OH)|Miami OH;Miami Ohio',
    'MICHIGAN|Michigan|',
    'MICHIGANST|Michigan State|Michigan St;Michigan St.',
    'MIDDLETENN|Middle Tennessee|Middle Tenn;Middle Tennessee State;MTSU',
    'MINNESOTA|Minnesota|',
    'MISSISSIPP|Mississippi State|Mississippi St;Mississippi St.',
    'MISSOURI|Missouri|',
    'MISSOURIST|Missouri State|Missouri St;Missouri St.',
    'NCSTATE|NC State|NC St;NC St.;NCSU;North Carolina St;North Carolina State',
    'NAVY|Navy|',
    'NEBRASKA|Nebraska|',
    'NEVADA|Nevada|',
    'NEWMEXICO|New Mexico|',
    'NEWMEXICOS|New Mexico State|New Mexico St;New Mexico St.',
    'NORTHCAROL|North Carolina|',
    'NORTHTEXAS|North Texas|',
    'NORTHERNIL|Northern Illinois|',
    'NORTHWESTE|Northwestern|',
    'NOTREDAME|Notre Dame|',
    'OHIO|Ohio|Ohio Bobcats',
    'OHIOSTATE|Ohio State|Ohio St;Ohio St.',
    'OKLAHOMA|Oklahoma|',
    'OKLAHOMAST|Oklahoma State|Oklahoma St;Oklahoma St.',
    'OLDDOMINIO|Old Dominion|',
    'OLEMISS|Ole Miss|Mississippi',
    'OREGON|Oregon|',
    'OREGONSTAT|Oregon State|Oregon St;Oregon St.',
    'PENNSTATE|Penn State|Penn St;Penn St.',
    'PITTSBURGH|Pittsburgh|Pitt',
    'PURDUE|Purdue|',
    'RICE|Rice|',
    'RUTGERS|Rutgers|',
    'SMU|SMU|Southern Methodist',
    'SAMHOUSTON|Sam Houston|Sam Houston State',
    'SANDIEGOST|San Diego State|San Diego St;San Diego St.',
    'SANJOSESTA|San José State|San Jose St;San Jose St.;San Jose State;San José St;San José St.',
    'SOUTHALABA|South Alabama|',
    'SOUTHCAROL|South Carolina|',
    'SOUTHFLORI|South Florida|',
    'SOUTHERNMI|Southern Miss|Southern Mississippi',
    'STANFORD|Stanford|',
    'SYRACUSE|Syracuse|',
    'TCU|TCU|Texas Christian',
    'TEMPLE|Temple|',
    'TENNESSEE|Tennessee|',
    'TEXAS|Texas|',
    'TEXASAM|Texas A&M|Texas A and M;Texas A M;Texas AandM',
    'TEXASSTATE|Texas State|Texas St;Texas St.',
    'TEXASTECH|Texas Tech|',
    'TOLEDO|Toledo|',
    'TROY|Troy|',
    'TULANE|Tulane|',
    'TULSA|Tulsa|',
    'UAB|UAB|Alabama Birmingham',
    'UCF|UCF|Central Florida',
    'UCLA|UCLA|',
    'UCONN|UConn|Connecticut',
    'ULMONROE|UL Monroe|Louisiana Monroe;Louisiana-Monroe;ULM',
    'UNLV|UNLV|Nevada Las Vegas',
    'USC|USC|Southern Cal;Southern California',
    'UTEP|UTEP|Texas El Paso',
    'UTSA|UTSA|Texas San Antonio',
    'UTAH|Utah|',
    'UTAHSTATE|Utah State|Utah St;Utah St.',
    'VANDERBILT|Vanderbilt|',
    'VIRGINIA|Virginia|',
    'VIRGINIATE|Virginia Tech|',
    'WAKEFOREST|Wake Forest|',
    'WASHINGTON|Washington|',
    'WASHINGTO2|Washington State|Washington St;Washington St.',
    'WESTVIRGIN|West Virginia|',
    'WESTERNKEN|Western Kentucky|WKU',
    'WESTERNMIC|Western Michigan|',
    'WISCONSIN|Wisconsin|',
    'WYOMING|Wyoming|'
  ];
  r text;
  parts text[];
  v_team uuid;
  a text;
begin
  foreach r in array rows loop
    parts := string_to_array(r, '|');

    insert into collective.teams (sport_code, code, name)
    values ('CFB', parts[1], parts[2])
    on conflict (sport_code, code) do nothing;
    select id into v_team from collective.teams where sport_code = 'CFB' and code = parts[1];

    -- the code and the canonical school name always resolve
    insert into collective.team_aliases (sport_code, alias, team_id)
    values ('CFB', parts[1], v_team), ('CFB', parts[2], v_team)
    on conflict do nothing;

    -- written variants
    if coalesce(parts[3], '') <> '' then
      foreach a in array string_to_array(parts[3], ';') loop
        if trim(a) <> '' then
          insert into collective.team_aliases (sport_code, alias, team_id)
          values ('CFB', trim(a), v_team)
          on conflict do nothing;
        end if;
      end loop;
    end if;
  end loop;
end $$;

-- ============================================================
-- 20260820000011_collective_ingest_fixes.sql
-- ============================================================
-- Model Collective, migration 11: two ingest fixes found from a live failure.
--
-- 1) Repair the projections to submissions foreign key on databases created
--    from an early setup paste. Ingest writes the projection rows first and
--    the parent submissions row last, inside one transaction, so the
--    constraint MUST be deferrable. Where it is not, every live submission
--    fails with a foreign key violation (surfacing as HTTP 500) while the
--    dry run, which writes nothing, happily returns 200. Idempotent: it is a
--    no-op on databases that already have it right.
--
-- 2) Let a creator repost a slate whose rows were quarantined. Idempotency by
--    payload hash was returning the original "all quarantined" answer forever,
--    so once the schedule was loaded the same file could never resolve.

do $$
declare
  c record;
begin
  select con.conname, con.condeferrable into c
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace ns on ns.oid = rel.relnamespace
  where ns.nspname = 'collective' and rel.relname = 'projections'
    and con.contype = 'f' and pg_get_constraintdef(con.oid) like '%submissions(id)%';
  if not found then
    raise notice 'projections submission FK not found, nothing to repair';
  elsif c.condeferrable then
    raise notice 'projections submission FK is already deferrable, no change';
  else
    execute format('alter table collective.projections alter constraint %I deferrable initially deferred', c.conname);
    raise notice 'REPAIRED: % is now deferrable initially deferred', c.conname;
  end if;
end $$;

create or replace function collective.ingest_submission(p_key jsonb, p_envelope jsonb, p_dry boolean default false) returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  v_model_id uuid := (p_key->>'model_id')::uuid;
  v_key_id uuid := (p_key->>'key_id')::uuid;
  v_sport text := p_envelope->>'sport';
  v_season int;
  v_origin collective.data_origin;
  v_received timestamptz := now();
  v_hash text;
  v_max_rows int := collective.cfg_int('ingest.max_rows', 500);
  v_rows jsonb := coalesce(p_envelope->'rows', '[]'::jsonb);
  row_j jsonb;
  v_out jsonb := '[]'::jsonb;
  v_sub_id uuid;
  v_game uuid;
  v_kick timestamptz;
  v_late boolean;
  v_candidate boolean;
  v_status text;
  v_reason text;
  n_res int := 0; n_quar int := 0; n_late int := 0; n_first int := 0; n_move int := 0; n_rej int := 0;
  v_resp jsonb;
  v_existing record;
  v_hwp numeric; v_spread numeric;
  v_pick collective.pick_side; v_tside collective.total_side;
  v_line numeric; v_ptot numeric; v_phs numeric; v_pas numeric;
  v_conf numeric; v_cover numeric; v_week int; v_env_week int;
  v_gen timestamptz;
  v_retry int;
begin
  -- Identity comes from the key, payload strings are only checked (8.2).
  if p_envelope ? 'model' and (p_envelope->>'model') is distinct from (p_key->>'model_slug') then
    return jsonb_build_object('ok', false, 'code', 'invalid_payload',
      'message', format('This key submits model "%s", not "%s"', p_key->>'model_slug', p_envelope->>'model'));
  end if;
  if v_sport is distinct from (p_key->>'sport') then
    return jsonb_build_object('ok', false, 'code', 'invalid_payload',
      'message', format('This key submits %s, the envelope says %s', p_key->>'sport', coalesce(v_sport, 'nothing')));
  end if;
  begin
    v_season := (p_envelope->>'season')::int;
  exception when others then v_season := null; end;
  if v_season is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_payload', 'message', 'season is required and must be an integer');
  end if;
  begin
    v_origin := (p_envelope->>'data_origin')::collective.data_origin;
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'invalid_payload', 'message', 'data_origin must be live, backfill, or test');
  end;
  -- A test key can only ever write test data.
  if (p_key->>'kind') = 'test' then v_origin := 'test'; end if;

  -- Envelope-level optionals are never allowed to abort the submission.
  begin v_env_week := nullif(p_envelope->>'week','')::int; exception when others then v_env_week := null; end;
  begin v_gen := nullif(p_envelope->>'generated_at','')::timestamptz; exception when others then v_gen := null; end;

  if jsonb_typeof(v_rows) <> 'array' or jsonb_array_length(v_rows) = 0 then
    return jsonb_build_object('ok', false, 'code', 'invalid_payload', 'message', 'rows must be a non-empty array');
  end if;
  if jsonb_array_length(v_rows) > v_max_rows then
    return jsonb_build_object('ok', false, 'code', 'invalid_payload',
      'message', format('%s rows exceeds the %s row maximum', jsonb_array_length(v_rows), v_max_rows));
  end if;

  -- Idempotency: same model, same payload, same answer (with duplicate:true).
  -- The advisory lock serializes concurrent identical submissions so the
  -- loser sees the winner's row here instead of a unique violation later.
  v_hash := md5(coalesce(p_envelope->>'idempotency_key', v_rows::text || v_origin::text || v_season::text));
  if not p_dry then
    perform pg_advisory_xact_lock(hashtext(v_model_id::text || ':' || v_hash));
    select * into v_existing from collective.submissions
     where model_id = v_model_id and payload_hash = v_hash;
    if found then
      -- A replay of a payload that fully landed returns the original answer.
      -- But a payload whose rows were QUARANTINED is a different story: the
      -- usual reason is that the schedule had not been loaded yet, and the
      -- creator reposting the same file afterwards is a genuine retry, not a
      -- duplicate. Let it through under a distinct hash so the rows get
      -- another chance to resolve. The first-submission lock still decides
      -- what counts for grading, so a true double delivery becomes movement
      -- and can never create a second graded candidate.
      if coalesce((v_existing.response->'counts'->>'quarantined')::int, 0) = 0 then
        return coalesce(v_existing.response, '{}'::jsonb) || jsonb_build_object('ok', true, 'duplicate', true);
      end if;
      select count(*) into v_retry from collective.submissions
       where model_id = v_model_id
         and (payload_hash = v_hash or payload_hash like v_hash || ':retry%');
      v_hash := v_hash || ':retry' || v_retry;
    end if;
  end if;

  v_sub_id := gen_random_uuid();

  for row_j in select * from jsonb_array_elements(v_rows) loop
    v_status := null; v_reason := null; v_game := null; v_late := false; v_candidate := false;

    -- Field validation. A rejected row is reported, never stored.
    if coalesce(row_j->>'game_ref','') = '' or coalesce(row_j->>'home_team','') = ''
       or coalesce(row_j->>'away_team','') = '' or coalesce(row_j->>'kickoff','') = '' then
      v_status := 'rejected'; v_reason := 'game_ref, home_team, away_team, and kickoff are required';
    end if;
    if v_status is null then
      begin
        v_kick := (row_j->>'kickoff')::timestamptz;
      exception when others then
        v_status := 'rejected'; v_reason := 'kickoff is not a valid timestamp';
      end;
    end if;
    if v_status is null then
      -- Every optional field parses inside this block: a bad value rejects
      -- THIS row only and can never abort the whole submission.
      begin
        v_hwp   := nullif(row_j->>'home_win_probability','')::numeric;
        v_spread:= nullif(row_j->>'projected_spread','')::numeric;
        v_cover := nullif(row_j->>'cover_probability','')::numeric;
        v_line  := nullif(row_j->>'line_at_submission','')::numeric;
        v_ptot  := nullif(row_j->>'projected_total','')::numeric;
        v_phs   := nullif(row_j->>'proj_home_score','')::numeric;
        v_pas   := nullif(row_j->>'proj_away_score','')::numeric;
        v_conf  := nullif(row_j->>'confidence','')::numeric;
        v_pick  := nullif(row_j->>'pick_side','')::collective.pick_side;
        v_tside := nullif(row_j->>'total_side','')::collective.total_side;
        v_week  := coalesce(nullif(row_j->>'week','')::int, v_env_week);
        if v_hwp is not null and (v_hwp < 0 or v_hwp > 1) then
          v_status := 'rejected'; v_reason := 'home_win_probability must be between 0 and 1';
        elsif v_cover is not null and (v_cover < 0 or v_cover > 1) then
          v_status := 'rejected'; v_reason := 'cover_probability must be between 0 and 1';
        elsif v_cover is not null and v_line is null then
          -- A pick probability is meaningless without its line (9.3).
          v_status := 'rejected'; v_reason := 'cover_probability requires line_at_submission';
        elsif v_hwp is not null and v_spread is not null and
              ((v_hwp > 0.5 and v_spread > 3) or (v_hwp < 0.5 and v_spread < -3)) then
          -- Win probability is not spread probability (9.2): an obvious
          -- contradiction is a mapping error and gets rejected loudly.
          v_status := 'rejected';
          v_reason := 'home_win_probability contradicts projected_spread; check that the probability is moneyline and the spread is home convention';
        end if;
      exception when others then
        v_status := 'rejected'; v_reason := 'a field failed to parse; check number formats and pick_side/total_side values';
      end;
    end if;

    if v_status is null then
      v_game := collective.resolve_game_ref(v_sport, v_season, row_j->>'home_team', row_j->>'away_team', v_kick);
      if v_game is null then
        v_status := 'quarantined';
        if collective.resolve_team(v_sport, row_j->>'home_team') is null then v_reason := 'unknown_team_home';
        elsif collective.resolve_team(v_sport, row_j->>'away_team') is null then v_reason := 'unknown_team_away';
        else v_reason := 'unknown_game'; end if;
        n_quar := n_quar + 1;
      else
        select v_received > g.kickoff_at into v_late from collective.games g where g.id = v_game;
        if v_late then
          -- Stored, flagged, excluded from grading (8.6).
          v_status := 'late'; n_late := n_late + 1;
        else
          v_status := 'resolved'; n_res := n_res + 1;
        end if;
        v_candidate := (not v_late) and v_origin = 'live'
          and not exists (select 1 from collective.projections px
                          where px.model_id = v_model_id and px.game_id = v_game and px.is_graded_candidate);
        if v_status = 'resolved' then
          if v_candidate then n_first := n_first + 1; else n_move := n_move + 1; end if;
        end if;
      end if;
    else
      n_rej := n_rej + 1;
    end if;

    if not p_dry and v_status <> 'rejected' then
      begin
        insert into collective.projections (
          submission_id, model_id, game_id, raw_game_ref, raw_row,
          resolution_status, quarantine_reason, sport_code, season, week,
          pick_side, total_side, line_at_submission, projected_spread, projected_total,
          proj_home_score, proj_away_score, home_win_prob, cover_prob, confidence,
          data_origin, received_at, is_late, is_graded_candidate)
        values (
          v_sub_id, v_model_id, v_game, row_j->>'game_ref', row_j,
          case when v_status = 'quarantined' then 'quarantined' else 'resolved' end::collective.resolution_status,
          case when v_status = 'quarantined' then v_reason end,
          v_sport, v_season, v_week,
          v_pick, v_tside, v_line, v_spread, v_ptot, v_phs, v_pas,
          v_hwp, v_cover, v_conf,
          v_origin, v_received, coalesce(v_late, false), v_candidate);
      exception when unique_violation then
        -- Concurrent first-lock race: the index is the law, this row
        -- becomes movement.
        insert into collective.projections (
          submission_id, model_id, game_id, raw_game_ref, raw_row,
          resolution_status, quarantine_reason, sport_code, season, week,
          pick_side, total_side, line_at_submission, projected_spread, projected_total,
          proj_home_score, proj_away_score, home_win_prob, cover_prob, confidence,
          data_origin, received_at, is_late, is_graded_candidate)
        values (
          v_sub_id, v_model_id, v_game, row_j->>'game_ref', row_j,
          'resolved', null, v_sport, v_season, v_week,
          v_pick, v_tside, v_line, v_spread, v_ptot, v_phs, v_pas,
          v_hwp, v_cover, v_conf,
          v_origin, v_received, coalesce(v_late, false), false);
        if v_candidate then n_first := n_first - 1; n_move := n_move + 1; v_candidate := false; end if;
      end;
    end if;

    v_out := v_out || jsonb_build_object(
      'game_ref', row_j->>'game_ref',
      'status', v_status,
      'game_id', v_game,
      'reason', v_reason);
  end loop;

  v_resp := jsonb_build_object(
    'ok', true,
    'submission_id', case when p_dry then null else v_sub_id::text end,
    'received_at', v_received,
    'data_origin', v_origin,
    'counts', jsonb_build_object(
      'rows', jsonb_array_length(v_rows), 'resolved', n_res + n_late, 'quarantined', n_quar,
      'late', n_late, 'first', n_first, 'movement', n_move, 'rejected', n_rej),
    'rows', v_out,
    'duplicate', false);

  if not p_dry then
    insert into collective.submissions (id, model_id, api_key_id, received_at, data_origin,
      client_generated_at, payload_hash, n_rows, n_resolved, n_quarantined, n_late, response)
    values (v_sub_id, v_model_id, v_key_id, v_received, v_origin,
      v_gen, v_hash,
      jsonb_array_length(v_rows), n_res + n_late, n_quar, n_late, v_resp);
  end if;

  return v_resp;
end $$;
