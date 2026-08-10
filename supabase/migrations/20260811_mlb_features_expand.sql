-- ============================================================================
-- Widen the MLB feature tables so the OWNED layer can hold everything the
-- research engine currently has to fetch live.
--
-- Why this matters beyond tidiness: while pitcher_features can only store five
-- Statcast columns, every question that needs ERA, FIP, whiff rate or a platoon
-- split has to go out to two external APIs at question time. That is slower,
-- rate-limited, and silently degrades the moment either feed changes. Once the
-- owned table can hold the whole picture, ingest_mlb fills it once a day and
-- the engine reads it — with the live path kept only as the fallback it was
-- always meant to be.
--
-- Every column is additive and nullable. Nothing existing changes meaning.
-- ============================================================================

-- ── pitcher_features: the traditional line, the derived line, provenance ────
alter table public.pitcher_features add column if not exists throws            text;
alter table public.pitcher_features add column if not exists era               numeric;
alter table public.pitcher_features add column if not exists whip              numeric;
alter table public.pitcher_features add column if not exists fip               numeric;
alter table public.pitcher_features add column if not exists fip_constant      numeric;
alter table public.pitcher_features add column if not exists hr_per_9          numeric;
alter table public.pitcher_features add column if not exists k_bb_ratio        numeric;
alter table public.pitcher_features add column if not exists ground_to_air     numeric;
alter table public.pitcher_features add column if not exists strike_pct        numeric;
alter table public.pitcher_features add column if not exists pitches_per_inning numeric;
alter table public.pitcher_features add column if not exists innings           numeric;
alter table public.pitcher_features add column if not exists batters_faced     integer;
alter table public.pitcher_features add column if not exists games_started     integer;
alter table public.pitcher_features add column if not exists whiff_pct         numeric;
alter table public.pitcher_features add column if not exists xwoba_against     numeric;
-- workload, so rest and pitch count stop needing a separate live game-log call
alter table public.pitcher_features add column if not exists last_start        date;
alter table public.pitcher_features add column if not exists days_rest         integer;
alter table public.pitcher_features add column if not exists recent_starts     jsonb;
-- provenance: which feed each half of the row came from, and when
alter table public.pitcher_features add column if not exists quality_source    text;
alter table public.pitcher_features add column if not exists line_source       text;
alter table public.pitcher_features add column if not exists updated_at        timestamptz;

comment on column public.pitcher_features.fip is
  'Computed from owned counting stats. fip_constant is solved from league totals in the same ingest run, never assumed.';
comment on column public.pitcher_features.quality_source is
  'Where the Statcast half came from (Baseball Savant), or null when it could not be read. A null here is a real gap, not a default.';

-- ── offense_features: platoon splits are the most matchup-relevant field ────
-- A right-hander does not face a lineup's season line, he faces its numbers
-- against right-handers. Storing only the overall line loses that every time.
alter table public.offense_features add column if not exists avg              numeric;
alter table public.offense_features add column if not exists slg              numeric;
alter table public.offense_features add column if not exists ops              numeric;
alter table public.offense_features add column if not exists bb_pct           numeric;
alter table public.offense_features add column if not exists home_runs        integer;
alter table public.offense_features add column if not exists plate_appearances integer;
alter table public.offense_features add column if not exists vs_lhp           jsonb;
alter table public.offense_features add column if not exists vs_rhp           jsonb;
alter table public.offense_features add column if not exists source           text;
alter table public.offense_features add column if not exists updated_at       timestamptz;

comment on column public.offense_features.vs_lhp is
  'This lineup''s hitting line against left-handed pitching. Null means the split was not retrievable, not that it is equal to the overall line.';

-- ── a health view, so "is the pipeline alive" is one query ─────────────────
-- The failure that started all of this went unnoticed for three weeks because
-- nothing surfaced it. This makes staleness visible without writing SQL.
create or replace view public.mlb_ingest_health as
select
  (select max(game_date) from public.games)                                    as games_latest_date,
  (select count(*) from public.games where game_date = current_date)           as games_today,
  (select count(*) from public.pitcher_features pf
     join public.games g on g.game_id = pf.game_id
    where g.game_date = current_date)                                          as starters_today,
  (select count(*) from public.pitcher_features pf
     join public.games g on g.game_id = pf.game_id
    where g.game_date = current_date and pf.xera is not null)                  as starters_with_statcast,
  (select count(*) from public.pitcher_features pf
     join public.games g on g.game_id = pf.game_id
    where g.game_date = current_date and pf.era is not null)                   as starters_with_line,
  (select count(*) from public.offense_features o
     join public.games g on g.game_id = o.game_id
    where g.game_date = current_date and o.vs_lhp is not null)                 as offense_with_splits,
  (select max(updated_at) from public.pitcher_features)                        as pitcher_features_updated_at;

comment on view public.mlb_ingest_health is
  'One row answering "is the MLB pipeline alive and complete for today". Read it before trusting any matchup research.';

grant select on public.mlb_ingest_health to authenticated;
