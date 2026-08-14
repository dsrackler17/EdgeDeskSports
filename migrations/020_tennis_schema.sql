-- ============================================================================
-- 020_tennis_schema.sql — EdgeDesk tennis deep-dive schema (ATP + WTA)
--
-- Purpose: hold licensed tennis facts (players, rankings, matches) and derive
-- every aggregate the app shows (season, surface, head-to-head, form) as views,
-- so there is exactly one source of truth and no aggregate can drift from it.
--
-- LICENSING IS ENFORCED BY THE SCHEMA, NOT BY GOOD INTENTIONS.
-- Every fact row carries a source_key. Every source declares whether its licence
-- permits commercial use. A trigger rejects any insert or update whose source is
-- not cleared for commercial use, so a non-commercial archive (for example the
-- CC BY-NC-SA Jeff Sackmann files) cannot be loaded into this database even by
-- accident. Clearing a source is a deliberate, auditable row change.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

create schema if not exists tennis;

-- ---------------------------------------------------------------- sources ---
create table if not exists tennis.sources (
  source_key      text primary key,
  display_name    text        not null,
  licence         text        not null,          -- human-readable licence name
  licence_url     text,
  commercial_use  boolean     not null,          -- the gate. false = cannot load.
  attribution     text,                          -- required credit line, if any
  notes           text,
  cleared_by      text,                          -- who verified the licence
  cleared_at      timestamptz,
  created_at      timestamptz not null default now()
);

comment on table  tennis.sources is
  'Every tennis data source with its licence. commercial_use gates ingestion.';
comment on column tennis.sources.commercial_use is
  'true only when the licence permits use in a paid product. Verified by a human; see cleared_by/cleared_at.';

-- Seeded DENIED so the ban is explicit and self-documenting rather than implied
-- by absence. Nothing can be ingested under these keys.
insert into tennis.sources (source_key, display_name, licence, licence_url, commercial_use, notes)
values
  ('sackmann_atp', 'Jeff Sackmann tennis_atp archive', 'CC BY-NC-SA 4.0',
   'https://creativecommons.org/licenses/by-nc-sa/4.0/', false,
   'Non-commercial and share-alike. Unusable in a paid product. Present here so the block is explicit.'),
  ('sackmann_wta', 'Jeff Sackmann tennis_wta archive', 'CC BY-NC-SA 4.0',
   'https://creativecommons.org/licenses/by-nc-sa/4.0/', false,
   'Non-commercial and share-alike. Unusable in a paid product. Present here so the block is explicit.')
on conflict (source_key) do nothing;

-- Placeholder for the licensed feed. commercial_use stays FALSE until a human
-- reads the contract and flips it, recording who and when. Ingestion fails
-- closed until then — which is the correct default.
insert into tennis.sources (source_key, display_name, licence, commercial_use, notes)
values
  ('licensed_feed', 'Licensed tennis data provider (configure before use)',
   'commercial subscription — record the exact plan and URL here', false,
   'Set commercial_use = true, licence, licence_url, attribution, cleared_by and cleared_at only after the subscription terms have been read and confirmed to cover this product.')
on conflict (source_key) do nothing;

-- The Odds API is already licensed and in use by this app for odds. Its scores
-- endpoint reaches only a few days back, so it can keep the board current but
-- cannot build history. commercial_use is left FALSE here as well: flip it only
-- after confirming the current plan covers storing scores.
insert into tennis.sources (source_key, display_name, licence, licence_url, commercial_use, notes)
values
  ('the_odds_api', 'The Odds API (odds + recent scores)', 'commercial subscription',
   'https://the-odds-api.com/', false,
   'Already used by this app for odds. Scores reach back only a few days — current form, never a historical archive. Confirm the plan permits storage before clearing.')
on conflict (source_key) do nothing;

-- --------------------------------------------------------------- the gate ---
create or replace function tennis.assert_commercial_source()
returns trigger
language plpgsql
as $$
declare ok boolean;
begin
  select commercial_use into ok from tennis.sources where source_key = new.source_key;
  if ok is null then
    raise exception 'tennis: unknown source_key %. Register it in tennis.sources first.', new.source_key
      using errcode = '23514';
  end if;
  if not ok then
    raise exception 'tennis: source % is not cleared for commercial use. Refusing to store it.', new.source_key
      using errcode = '23514',
            hint = 'Read the licence. If it genuinely permits use in a paid product, set tennis.sources.commercial_use = true with cleared_by and cleared_at.';
  end if;
  return new;
end;
$$;

comment on function tennis.assert_commercial_source is
  'Fails closed: a fact row cannot be stored unless its source is explicitly cleared for commercial use.';

-- --------------------------------------------------------------- players ----
create table if not exists tennis.players (
  player_id     text        not null,
  tour          text        not null check (tour in ('ATP','WTA')),
  full_name     text        not null,
  country       text,
  plays         text,                             -- handedness as published
  height_cm     integer,
  birth_date    date,
  source_key    text        not null references tennis.sources(source_key),
  retrieved_at  timestamptz not null default now(),
  primary key (tour, player_id)
);
create index if not exists tennis_players_name_idx on tennis.players (tour, lower(full_name));

-- -------------------------------------------------------------- rankings ----
create table if not exists tennis.rankings (
  tour          text        not null check (tour in ('ATP','WTA')),
  player_id     text        not null,
  as_of         date        not null,
  rank          integer     not null,
  points        integer,
  source_key    text        not null references tennis.sources(source_key),
  retrieved_at  timestamptz not null default now(),
  primary key (tour, as_of, player_id)
);
create index if not exists tennis_rankings_current_idx on tennis.rankings (tour, as_of desc, rank asc);

-- --------------------------------------------------------------- matches ----
create table if not exists tennis.matches (
  match_id      text        not null,
  tour          text        not null check (tour in ('ATP','WTA')),
  match_date    date        not null,
  season        integer     generated always as (extract(year from match_date)::int) stored,
  tourney_id    text,
  tourney_name  text,
  surface       text,                             -- as published; never inferred
  level         text,                             -- G / M / A / D / F etc, as published
  round         text,
  best_of       integer,
  winner_id     text        not null,
  loser_id      text        not null,
  score         text,
  minutes       integer,
  winner_rank   integer,
  loser_rank    integer,
  source_key    text        not null references tennis.sources(source_key),
  retrieved_at  timestamptz not null default now(),
  primary key (tour, match_id)
);
create index if not exists tennis_matches_winner_idx  on tennis.matches (tour, winner_id, match_date desc);
create index if not exists tennis_matches_loser_idx   on tennis.matches (tour, loser_id,  match_date desc);
create index if not exists tennis_matches_season_idx  on tennis.matches (tour, season);
create index if not exists tennis_matches_surface_idx on tennis.matches (tour, surface);

-- ------------------------------------------------------------------ meta ----
-- Build times live here so the app's freshness SLA can be REAL for this module
-- instead of inactive. Written by the ingestion job, never by the client.
create table if not exists tennis.meta (
  key          text primary key,
  value        text,
  updated_at   timestamptz not null default now()
);
comment on table tennis.meta is
  'Pipeline build stamps, e.g. last_ingest, last_aggregate, rankings_as_of. The app reads these for its freshness SLA.';

-- --------------------------------------------------------------- triggers ---
drop trigger if exists players_source_gate  on tennis.players;
drop trigger if exists rankings_source_gate on tennis.rankings;
drop trigger if exists matches_source_gate  on tennis.matches;

create trigger players_source_gate  before insert or update on tennis.players
  for each row execute function tennis.assert_commercial_source();
create trigger rankings_source_gate before insert or update on tennis.rankings
  for each row execute function tennis.assert_commercial_source();
create trigger matches_source_gate  before insert or update on tennis.matches
  for each row execute function tennis.assert_commercial_source();

-- ============================================================================
-- DERIVED VIEWS — every aggregate the app displays is computed here from
-- tennis.matches. No aggregate is stored, so none can disagree with the facts.
-- ============================================================================

-- one row per player per match, so aggregates read naturally
create or replace view tennis.match_sides as
  select tour, match_id, match_date, season, surface, level, tourney_name, round,
         winner_id as player_id, loser_id  as opponent_id, true  as won, source_key
    from tennis.matches
  union all
  select tour, match_id, match_date, season, surface, level, tourney_name, round,
         loser_id  as player_id, winner_id as opponent_id, false as won, source_key
    from tennis.matches;

create or replace view tennis.player_season as
  select tour, player_id, season,
         count(*) filter (where won)            as wins,
         count(*) filter (where not won)        as losses,
         count(*)                               as matches,
         round(count(*) filter (where won)::numeric
               / nullif(count(*),0), 4)         as win_pct
    from tennis.match_sides
   group by tour, player_id, season;

create or replace view tennis.player_surface as
  select tour, player_id, season, surface,
         count(*) filter (where won)            as wins,
         count(*) filter (where not won)        as losses,
         count(*)                               as matches,
         round(count(*) filter (where won)::numeric
               / nullif(count(*),0), 4)         as win_pct
    from tennis.match_sides
   where surface is not null
   group by tour, player_id, season, surface;

create or replace view tennis.player_career as
  select tour, player_id,
         count(*) filter (where won)            as wins,
         count(*) filter (where not won)        as losses,
         count(*)                               as matches,
         round(count(*) filter (where won)::numeric
               / nullif(count(*),0), 4)         as win_pct,
         min(match_date)                        as first_match,
         max(match_date)                        as last_match
    from tennis.match_sides
   group by tour, player_id;

-- head to head, one row per ordered pair (both directions present)
create or replace view tennis.h2h as
  select tour, player_id, opponent_id,
         count(*) filter (where won)     as wins,
         count(*) filter (where not won) as losses,
         count(*)                        as matches,
         max(match_date)                 as last_meeting
    from tennis.match_sides
   group by tour, player_id, opponent_id;

-- current ranking = the most recent as_of date present per tour
create or replace view tennis.rankings_current as
  select r.tour, r.player_id, r.rank, r.points, r.as_of
    from tennis.rankings r
    join (select tour, max(as_of) as as_of from tennis.rankings group by tour) m
      on m.tour = r.tour and m.as_of = r.as_of;

-- last 20 completed matches per player, for the form strip
create or replace view tennis.player_form as
  select *
    from (select s.*, row_number() over (partition by s.tour, s.player_id
                                             order by s.match_date desc) as rn
            from tennis.match_sides s) t
   where rn <= 20;

-- ============================================================================
-- RLS + grants. Reads mirror the app's other research schemas: authenticated
-- users may select; nobody writes from the browser. Ingestion uses the service
-- role, which bypasses RLS.
-- ============================================================================
alter table tennis.sources  enable row level security;
alter table tennis.players  enable row level security;
alter table tennis.rankings enable row level security;
alter table tennis.matches  enable row level security;
alter table tennis.meta     enable row level security;

do $$
declare t text;
begin
  foreach t in array array['sources','players','rankings','matches','meta'] loop
    execute format(
      'drop policy if exists %I on tennis.%I', 'read_'||t, t);
    execute format(
      'create policy %I on tennis.%I for select to authenticated using (true)', 'read_'||t, t);
  end loop;
end $$;

grant usage on schema tennis to authenticated, anon;
grant select on all tables in schema tennis to authenticated;
alter default privileges in schema tennis grant select on tables to authenticated;

-- Views inherit the base tables' RLS (security invoker in PG15+); grant select
-- so PostgREST can expose them.
grant select on tennis.match_sides, tennis.player_season, tennis.player_surface,
                tennis.player_career, tennis.h2h, tennis.rankings_current,
                tennis.player_form
  to authenticated;

-- ============================================================================
-- AFTER RUNNING THIS FILE:
--   1. Supabase → Settings → API → Exposed schemas: add `tennis`.
--   2. Register and CLEAR your licensed source:
--        update tennis.sources
--           set commercial_use = true,
--               display_name = '<provider>',
--               licence      = '<exact plan/licence name>',
--               licence_url  = '<terms URL>',
--               attribution  = '<required credit line, or null>',
--               cleared_by   = '<who read the contract>',
--               cleared_at   = now()
--         where source_key = 'licensed_feed';
--      Until this is done every ingest fails closed, by design.
--   3. Deploy and schedule the tennis_ingest edge function.
-- ============================================================================
