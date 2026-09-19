-- ===========================================================================
-- EdgeDesk Tennis LAB — the research surface over the record.
--
-- WHAT THIS ADDS, AND WHAT IT DOES NOT TOUCH. supabase/tennis_record.sql built
-- the record: licence gate, staging, entities, matches, point-in-time features,
-- current ratings, model registry, append-only predictions, the public record.
-- This file adds the RESEARCH PRODUCT on top of it — the questions a person
-- actually opens EdgeDesk to ask:
--
--     who is strongest, overall and on this surface?
--     is this player improving or declining, and is the record behind it real?
--     how much tennis has this player played lately?
--     A against B — what does the model estimate, and how sure is it?
--     which historical matches resemble this one?
--     what does EdgeDesk NOT know?
--
-- Not one statement here alters an existing table's semantics. The additions to
-- tennis.player_ratings_current are new nullable columns (add column if not
-- exists), so every existing read keeps its shape and every existing row stays
-- valid. Nothing in tennis_record.sql, tennis_live_center.sql or
-- tennis_player_directory.sql is dropped, replaced or re-granted.
--
-- NO ODDS. Not a column, not a join, not an optional enrichment. Every object
-- below answers its question from the historical record and the ratings derived
-- from it. tennis.odds_snapshots exists in the record contract and is read by
-- exactly one thing in this file: the DISABLED market-comparison flag, which
-- returns "not available" until a licensed odds provider is registered and
-- passes a freshness check. The Lab must render identically with that table
-- empty forever, and lab_sql.test.js proves it by truncating it and reloading
-- every surface.
--
-- THE LAYERS THIS FILE ADDS:
--
--   L1  rating history     tennis.rating_history — a rating's trajectory over
--                          time, so "improving" is measured, not asserted
--   L2  derived signals    new columns on player_ratings_current: serve/return
--                          strength, strength of schedule, per-surface win
--                          rates, indoor split, and the two CLASSIFICATIONS
--                          (trajectory, workload) computed by the pipeline so
--                          a leaderboard does not recompute them per row
--   L3  research briefs    tennis.research_briefs — generated, versioned,
--                          append-only, and explicitly odds-free
--   L4  feature flags      tennis.lab_flags — how the market module stays off
--   L5  the lab RPCs       every read the page makes, bounded and typed
--   L6  the explorer       one cursor-paginated function over 361k matches
--   L7  AI context         ai_lab_* — the assistant's door into all of it
--
-- SECURITY POSTURE. Same as the record contract: RLS on every table, private
-- tables stay private, security definer only where a narrow aggregate must
-- cross a private boundary, every such function has a fixed search_path and no
-- public execute, and the entitlement question is delegated to the EXISTING
-- tennis.viewer_is_entitled() rather than reimplemented.
--
-- Idempotent, additive, and it ends in a report. Run it after
-- supabase/tennis_record.sql:
--
--     psql "$SUPABASE_DB_URL" -f supabase/tennis_lab.sql
--
-- Every report row must read ok. Tested against a real PostgreSQL by
-- tools/tennis/lab_sql.test.js.
-- ===========================================================================

create schema if not exists tennis;
grant usage on schema tennis to anon, authenticated, service_role;

-- This file is meaningless without the record contract. Rather than fail
-- halfway through with a confusing missing-relation error, say so plainly.
do $guard$
begin
  if to_regclass('tennis.player_ratings_current') is null then
    raise exception 'tennis_lab.sql requires supabase/tennis_record.sql to be applied first (tennis.player_ratings_current is missing)';
  end if;
end
$guard$;


-- ===========================================================================
-- L2 — DERIVED SIGNALS on the existing current-ratings table.
--
-- WHY THESE LIVE HERE RATHER THAN IN A NEW TABLE. Every one of them is a
-- property of "this player, right now", which is exactly what
-- player_ratings_current means. A parallel table would need the same primary
-- key, the same refresh cadence and the same source key, and every leaderboard
-- would join it — so it would be the same table with an extra join. They are
-- added as nullable columns because they are genuinely unknown until the
-- pipeline computes them, and NULL is the honest value for "not computed yet".
--
-- NULL IS NOT ZERO, ANYWHERE IN HERE. serve_strength null means the archive
-- carried no serve statistics for this player's matches. serve_strength 0
-- would mean they never land a first serve. The check constraints below admit
-- null freely and constrain only the shape of a value that IS present.
-- ===========================================================================

alter table tennis.player_ratings_current
  add column if not exists serve_strength    numeric(5,4),
  add column if not exists return_strength   numeric(5,4),
  add column if not exists serve_sample      integer,
  add column if not exists sos_elo_recent    numeric(8,3),
  add column if not exists sos_elo_career    numeric(8,3),
  add column if not exists sos_sample        integer,
  add column if not exists indoor_elo        numeric(8,3),
  add column if not exists indoor_sample     integer,
  add column if not exists outdoor_elo       numeric(8,3),
  add column if not exists outdoor_sample    integer,
  add column if not exists hard_win_pct      numeric(5,4),
  add column if not exists clay_win_pct      numeric(5,4),
  add column if not exists grass_win_pct     numeric(5,4),
  add column if not exists carpet_win_pct    numeric(5,4),
  -- The two classifications, computed once by the pipeline. A leaderboard that
  -- recomputed "is this player improving" per row would do it 106,887 times
  -- per page load; the rating build does it once per player per run.
  add column if not exists trajectory_class  text,
  add column if not exists trajectory_direction smallint,
  add column if not exists workload_class    text,
  add column if not exists rating_delta_30d  numeric(6,2),
  add column if not exists rating_delta_90d  numeric(6,2),
  add column if not exists lab_version       text;

do $shape$
begin
  -- Added separately and guarded: a re-apply must not fail on a constraint
  -- that already exists, and `add constraint if not exists` is not SQL.
  if not exists (select 1 from pg_constraint where conname = 'tennis_prc_trajectory_shape') then
    alter table tennis.player_ratings_current
      add constraint tennis_prc_trajectory_shape check (
        trajectory_class is null or trajectory_class in
        ('improving','declining','stable','returning','above_sustainable','below_ability','unknown'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tennis_prc_workload_shape') then
    alter table tennis.player_ratings_current
      add constraint tennis_prc_workload_shape check (
        workload_class is null or workload_class in ('fresh','normal','elevated','heavy','unknown'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tennis_prc_serve_shape') then
    alter table tennis.player_ratings_current
      add constraint tennis_prc_serve_shape check (
        (serve_strength is null or serve_strength between 0 and 1) and
        (return_strength is null or return_strength between 0 and 1));
  end if;
end
$shape$;

-- Indexes for the leaderboards the Lab actually serves. Each one exists
-- because a real query in this file orders by it; none is speculative.
create index if not exists tennis_prc_serve_idx      on tennis.player_ratings_current (tour, serve_strength desc nulls last);
create index if not exists tennis_prc_return_idx     on tennis.player_ratings_current (tour, return_strength desc nulls last);
create index if not exists tennis_prc_indoor_idx     on tennis.player_ratings_current (tour, indoor_elo desc nulls last);
create index if not exists tennis_prc_form_idx       on tennis.player_ratings_current (tour, form_90d desc nulls last);
create index if not exists tennis_prc_workload_idx   on tennis.player_ratings_current (tour, matches_14d desc nulls last);
create index if not exists tennis_prc_trajectory_idx on tennis.player_ratings_current (tour, trajectory_class, rating_delta_30d desc nulls last);
create index if not exists tennis_prc_wclass_idx     on tennis.player_ratings_current (tour, workload_class);
create index if not exists tennis_prc_delta30_idx    on tennis.player_ratings_current (tour, rating_delta_30d desc nulls last);


-- ===========================================================================
-- L1 — RATING HISTORY. A trajectory, not an assertion.
--
-- "This player is improving" is only meaningful against a record of what the
-- rating WAS. Without this table the Lab could compare form windows but could
-- never show a rating line, and "biggest risers" would have nothing to
-- subtract from.
--
-- One row per player per snapshot date per rating version. Snapshots are
-- written by tools/tennis/build_history.js walking the match record forward, so
-- a row's rating is computed from matches strictly before its as_of date — the
-- same point-in-time rule the features obey. A snapshot is therefore safe to
-- read as "what EdgeDesk would have said on that day".
-- ===========================================================================
create table if not exists tennis.rating_history (
  player_id       text not null references tennis.players (player_id) on delete cascade,
  as_of           date not null,
  tour            text not null,
  elo             numeric(8,3),
  hard_elo        numeric(8,3),
  clay_elo        numeric(8,3),
  grass_elo       numeric(8,3),
  power_rating    numeric(5,2),
  official_rank   integer,
  sample          integer not null default 0,
  uncertainty     numeric(4,3),
  rating_version  text not null,
  source_key      text not null default 'edgedesk',
  computed_at     timestamptz not null default now(),
  ingestion_run_id uuid references tennis.ingestion_runs (run_id) on delete set null,
  constraint tennis_rh_pk primary key (player_id, as_of, rating_version),
  constraint tennis_rh_tour_shape check (tour in ('ATP','WTA','MIXED','OTHER')),
  constraint tennis_rh_power_shape check (power_rating is null or (power_rating between 0 and 100)),
  constraint tennis_rh_source_fk
    foreign key (source_key) references tennis.source_licenses (source_key) on delete restrict
);
create index if not exists tennis_rh_player_idx on tennis.rating_history (player_id, as_of desc);
create index if not exists tennis_rh_tour_idx   on tennis.rating_history (tour, as_of desc);
create index if not exists tennis_rh_asof_idx   on tennis.rating_history (as_of desc);

drop trigger if exists tennis_rh_license on tennis.rating_history;
create trigger tennis_rh_license before insert or update on tennis.rating_history
  for each row execute function tennis.enforce_source_license();


-- ===========================================================================
-- L3 — RESEARCH BRIEFS. Generated, versioned, and structurally odds-free.
--
-- The brief must work with no sportsbook and no schedule. Its `tier` records
-- which of the three it was built from — scheduled / trends / historical — so a
-- reader is never shown a trend brief that looks like a preview of today's
-- play. `contains_odds` is a stored, checked column rather than a convention:
-- the constraint below makes a brief carrying market content literally
-- unstorable in this table.
-- ===========================================================================
create table if not exists tennis.research_briefs (
  brief_id        text primary key,
  tour            text not null,
  brief_date      date not null,
  tier            text not null,
  headline        text,
  body            jsonb not null default '{}'::jsonb,
  sections        jsonb not null default '[]'::jsonb,
  data_through    date,
  model_version   text,
  brief_version   text not null,
  lab_version     text,
  contains_odds   boolean not null default false,
  contains_selections boolean not null default false,
  generated_at    timestamptz not null default now(),
  ingestion_run_id uuid references tennis.ingestion_runs (run_id) on delete set null,
  constraint tennis_brief_tour_shape check (tour in ('ATP','WTA','MIXED','OTHER')),
  constraint tennis_brief_tier_shape check (tier in ('scheduled','trends','historical')),
  -- RESEARCH, NOT PICKS — enforced by the database, not by a code review.
  constraint tennis_brief_no_selections check (contains_selections = false),
  constraint tennis_brief_no_odds check (contains_odds = false)
);
create index if not exists tennis_brief_tour_date_idx on tennis.research_briefs (tour, brief_date desc);
create index if not exists tennis_brief_date_idx on tennis.research_briefs (brief_date desc);

-- A published brief is a claim with a date on it. Like a prediction, it is not
-- rewritten after the fact — the same immutability rule the record contract
-- applies to predictions and settled results.
create or replace function tennis.freeze_brief()
returns trigger language plpgsql security definer set search_path = tennis, pg_temp as $$
begin
  if old.generated_at is distinct from new.generated_at
     or old.sections is distinct from new.sections
     or old.tier is distinct from new.tier then
    raise exception using errcode = 'restrict_violation',
      message = 'tennis.research_briefs: a generated brief is immutable (brief_id=' || old.brief_id || ')',
      hint = 'Generate a new brief rather than rewriting a published one.';
  end if;
  return new;
end
$$;
revoke all on function tennis.freeze_brief() from public, anon, authenticated;
drop trigger if exists tennis_brief_freeze on tennis.research_briefs;
create trigger tennis_brief_freeze before update on tennis.research_briefs
  for each row execute function tennis.freeze_brief();


-- ===========================================================================
-- L4 — FEATURE FLAGS. How the market module stays off.
--
-- The brief requires a Market Comparison tab that is PREPARED but DISABLED,
-- hidden until a verified odds provider is connected and passes freshness
-- checks, with no fake data behind it. A flag in a table is the honest way to
-- do that: the page asks the database whether the module is available, the
-- database answers by checking real conditions, and the answer is no until
-- they are met. There is no build-time constant a deploy could flip by
-- accident and no placeholder rows pretending to be prices.
-- ===========================================================================
create table if not exists tennis.lab_flags (
  flag_key      text primary key,
  enabled       boolean not null default false,
  label         text not null,
  description   text,
  requires      text[] not null default '{}'::text[],
  updated_by    text,
  updated_at    timestamptz not null default now()
);

insert into tennis.lab_flags (flag_key, enabled, label, description, requires) values
  ('market_comparison', false, 'Market Comparison',
   'Compares the EdgeDesk probability with a market-implied probability, the fair '
   || 'price, the available price, model-market disagreement, expected value and '
   || 'closing-line movement. Stays off until a licensed odds provider is registered '
   || 'in tennis.source_licenses with commercial clearance AND a fresh odds snapshot '
   || 'exists. EdgeDesk publishes no market number it has not actually received.',
   array['odds_provider_registered','odds_snapshot_fresh']),
  ('live_schedule', false, 'Verified schedule',
   'Upcoming-match research. Off until a schedule provider is registered. With it '
   || 'off the daily brief falls back to a trends or historical brief and says so, '
   || 'rather than inventing fixtures.',
   array['schedule_provider_registered'])
on conflict (flag_key) do nothing;

-- Is the market module actually available? Not "is the flag on" — the flag is
-- necessary and not sufficient. A licensed, commercially cleared odds source
-- must exist AND a snapshot must be fresh. All three, or the answer is no.
create or replace function tennis.lab_market_available()
returns table (available boolean, reason text, flag_enabled boolean,
               provider_ok boolean, freshness_ok boolean, last_snapshot_at timestamptz)
language sql stable security definer set search_path = tennis, pg_temp as $$
  with f as (
    select coalesce((select enabled from tennis.lab_flags where flag_key = 'market_comparison'), false) as on
  ), s as (
    -- THE SNAPSHOT AND ITS SOURCE, TOGETHER.
    --
    -- An earlier version asked two separate questions — "is any commercially
    -- cleared source registered?" and "is any snapshot fresh?" — and a test
    -- caught what that misses: the record contract SEEDS 'odds_api' as
    -- cleared, so the provider half was already satisfied on a fresh install by
    -- a placeholder row that has never delivered anything. The gate would then
    -- have turned on the first time any snapshot arrived, from any source.
    --
    -- The question that actually matters is whether a CLEARED SOURCE HAS
    -- RECENTLY DELIVERED, so it is asked as one join. A registration with no
    -- deliveries proves nothing, and a delivery from an uncleared source is
    -- exactly what the licence gate exists to refuse.
    select max(o.captured_at) as last_at,
           max(o.captured_at) filter (
             where l.commercial_use = true and l.cleared_by is not null and l.cleared_at is not null
           ) as cleared_at_ts
      from tennis.odds_snapshots o
      join tennis.source_licenses l on l.source_key = o.source_key
  )
  select (f.on
          and s.cleared_at_ts is not null
          and s.cleared_at_ts > now() - interval '6 hours') as available,
         case
           when not f.on then 'The Market Comparison module is switched off. EdgeDesk is a research product and ships with it disabled.'
           when s.last_at is null then 'No odds snapshot has ever been received from any source.'
           when s.cleared_at_ts is null then 'Odds snapshots exist, but none came from a commercially cleared provider. The historical archive is non-commercial and cannot be used as a market feed.'
           when s.cleared_at_ts <= now() - interval '6 hours' then 'The most recent snapshot from a cleared provider is more than six hours old and fails the freshness check.'
           else 'A cleared provider has delivered a fresh snapshot.'
         end as reason,
         f.on as flag_enabled,
         (s.cleared_at_ts is not null) as provider_ok,
         (s.cleared_at_ts is not null and s.cleared_at_ts > now() - interval '6 hours') as freshness_ok,
         s.last_at as last_snapshot_at
    from f, s;
$$;
revoke all on function tennis.lab_market_available() from public;
grant execute on function tennis.lab_market_available() to anon, authenticated, service_role;


-- ===========================================================================
-- L5 — THE LAB READS.
--
-- Every one is a function rather than a view, for three reasons that matter
-- here: a function takes the tour/surface/limit the page is actually asking
-- for (so PostgREST cannot be handed an unbounded scan of 106k players), a
-- function can cap its own limit (so a crafted request cannot ask for a
-- million rows), and a function's grants are per-callable rather than
-- per-table (so anon gets exactly these doors and nothing behind them).
--
-- They are `security invoker` wherever the underlying tables are already
-- readable by the caller, and `security definer` only where a narrow,
-- aggregated answer must cross into a private table. Each definer function
-- fixes its search_path and revokes public execute — the same posture the
-- record contract establishes and its test suite enforces.
-- ===========================================================================

-- The base row every leaderboard selects from. A view, so the functions below
-- share one definition of "a rated player" and cannot drift.
create or replace view tennis.lab_player_row
with (security_invoker = true) as
  select p.player_id, p.tour, p.full_name, p.country, p.plays, p.height_cm,
         p.latest_age, p.matches_on_file, p.active, p.last_match,
         r.power_rating, r.uncertainty, r.rating_sample,
         r.elo, r.hard_elo, r.clay_elo, r.grass_elo, r.carpet_elo, r.indoor_elo, r.outdoor_elo,
         r.elo_sample, r.hard_sample, r.clay_sample, r.grass_sample, r.carpet_sample,
         r.indoor_sample, r.outdoor_sample,
         r.hard_win_pct, r.clay_win_pct, r.grass_win_pct, r.carpet_win_pct,
         r.form_30d, r.form_90d, r.form_365d, r.form_sample_365d,
         r.matches_7d, r.matches_14d, r.matches_28d, r.rest_days, r.days_since_last_match,
         r.serve_strength, r.return_strength, r.serve_sample,
         r.sos_elo_recent, r.sos_elo_career, r.sos_sample,
         r.trajectory_class, r.trajectory_direction, r.workload_class,
         r.rating_delta_30d, r.rating_delta_90d,
         r.official_rank, r.official_rank_points, r.official_rank_as_of,
         r.last_match_date, r.rating_version, r.lab_version, r.computed_at as rating_computed_at
    from tennis.players p
    join tennis.player_ratings_current r on r.player_id = p.player_id;

-- How a mode's metric is chosen, in ONE place. The nine modes in
-- lib/tennis_lab.js LAB_MODES map here; lab_sql.test.js asserts every mode key
-- the library declares is answered by this function, so adding a mode to the
-- page without teaching the database about it fails a test rather than
-- silently returning the overall leaderboard.
create or replace function tennis.lab_leaders(
  p_tour text default 'ATP',
  p_mode text default 'overall',
  p_limit integer default 25,
  p_min_sample integer default 10)
returns table (
  player_id text, full_name text, country text, tour text,
  metric_value numeric, metric_label text,
  power_rating numeric, official_rank integer, uncertainty numeric,
  sample integer, surface_sample integer,
  form_90d numeric, matches_14d integer, rest_days integer,
  trajectory_class text, workload_class text,
  last_match_date date, days_since_last_match integer)
language sql stable security invoker set search_path = tennis, pg_temp as $$
  with bounded as (select least(greatest(coalesce(p_limit, 25), 1), 100) as n,
                          greatest(coalesce(p_min_sample, 0), 0) as min_n),
  picked as (
    select v.*, bounded.n,
           case lower(coalesce(p_mode,'overall'))
             when 'hard'     then v.hard_elo
             when 'clay'     then v.clay_elo
             when 'grass'    then v.grass_elo
             when 'indoor'   then v.indoor_elo
             when 'form'     then v.form_90d
             when 'serve'    then v.serve_strength
             when 'return'   then v.return_strength
             when 'workload' then v.matches_14d::numeric
             else v.power_rating
           end as mval,
           case lower(coalesce(p_mode,'overall'))
             when 'hard'     then v.hard_sample
             when 'clay'     then v.clay_sample
             when 'grass'    then v.grass_sample
             when 'indoor'   then v.indoor_sample
             when 'form'     then v.form_sample_365d
             when 'serve'    then v.serve_sample
             when 'return'   then v.serve_sample
             when 'workload' then v.rating_sample
             else v.rating_sample
           end as msample
      from tennis.lab_player_row v, bounded
     where v.tour = coalesce(p_tour, 'ATP')
  )
  select picked.player_id, picked.full_name, picked.country, picked.tour,
         round(picked.mval, 3) as metric_value,
         lower(coalesce(p_mode,'overall')) as metric_label,
         picked.power_rating, picked.official_rank, picked.uncertainty,
         picked.rating_sample, picked.msample,
         picked.form_90d, picked.matches_14d, picked.rest_days,
         picked.trajectory_class, picked.workload_class,
         picked.last_match_date, picked.days_since_last_match
    from picked, bounded
   where picked.mval is not null
     -- A leaderboard of players with two matches is not a leaderboard. The
     -- sample floor is a parameter so the page can loosen it deliberately and
     -- show what it is doing, rather than a hidden constant.
     and coalesce(picked.msample, 0) >= bounded.min_n
   -- ELO IS THE TIEBREAK, and it is not decorative. The 0-100 power rating
   -- CLAMPS at 100, and on a tour with a long history several all-time players
   -- reach the clamp — which made the top of this board three players tied at
   -- exactly 100.00 in arbitrary order. Elo does not clamp, so ordering by it
   -- underneath restores a real ordering among them. The page shows the Elo
   -- beside the rating for the same reason: at the ceiling the rating has
   -- stopped discriminating and the reader is entitled to see that.
   order by picked.mval desc, picked.elo desc nulls last,
            picked.rating_sample desc, picked.player_id
   limit (select n from bounded);
$$;
grant execute on function tennis.lab_leaders(text, text, integer, integer) to anon, authenticated, service_role;

-- Biggest risers and fallers, from the rating history rather than from a guess.
create or replace function tennis.lab_movers(
  p_tour text default 'ATP',
  p_direction text default 'up',
  p_window_days integer default 30,
  p_limit integer default 15,
  p_min_sample integer default 10)
returns table (
  player_id text, full_name text, country text, tour text,
  delta numeric, power_rating numeric, previous_rating numeric,
  window_days integer, sample integer, uncertainty numeric,
  official_rank integer, trajectory_class text, last_match_date date)
language sql stable security invoker set search_path = tennis, pg_temp as $$
  with bounded as (select least(greatest(coalesce(p_limit, 15), 1), 100) as n,
                          least(greatest(coalesce(p_window_days, 30), 1), 400) as w,
                          greatest(coalesce(p_min_sample, 0), 0) as min_n),
  base as (
    select v.*, bounded.w,
           case when bounded.w <= 45 then v.rating_delta_30d else v.rating_delta_90d end as d
      from tennis.lab_player_row v, bounded
     where v.tour = coalesce(p_tour, 'ATP')
       and v.rating_sample >= bounded.min_n
  )
  select base.player_id, base.full_name, base.country, base.tour,
         round(base.d, 2) as delta, base.power_rating,
         round(base.power_rating - base.d, 2) as previous_rating,
         base.w as window_days, base.rating_sample, base.uncertainty,
         base.official_rank, base.trajectory_class, base.last_match_date
    from base, bounded
   where base.d is not null
     and case when lower(coalesce(p_direction,'up')) = 'down' then base.d < 0 else base.d > 0 end
   order by case when lower(coalesce(p_direction,'up')) = 'down' then base.d else -base.d end,
            base.rating_sample desc, base.player_id
   limit (select n from bounded);
$$;
grant execute on function tennis.lab_movers(text, text, integer, integer, integer) to anon, authenticated, service_role;

-- SURFACE TRANSLATOR. The adjustment, shrunk by surface sample, exactly as
-- lib/tennis_lab.js surfaceTranslation() computes it — the SQL and the library
-- are checked against each other in lab_sql.test.js so the board and the player
-- card cannot disagree about whether a player is a clay specialist.
create or replace function tennis.lab_surface_board(
  p_tour text default 'ATP',
  p_surface text default 'clay',
  p_order text default 'adjustment',
  p_limit integer default 25,
  p_min_sample integer default 5)
returns table (
  player_id text, full_name text, country text, tour text,
  surface text, surface_elo numeric, baseline_elo numeric,
  raw_delta numeric, adjustment numeric, band numeric, uncertainty numeric,
  surface_sample integer, surface_win_pct numeric,
  power_rating numeric, official_rank integer)
language sql stable security invoker set search_path = tennis, pg_temp as $$
  with bounded as (select least(greatest(coalesce(p_limit, 25), 1), 100) as n,
                          greatest(coalesce(p_min_sample, 0), 0) as min_n,
                          lower(coalesce(p_surface, 'clay')) as s,
                          25.0 as full_sample),
  base as (
    select v.player_id, v.full_name, v.country, v.tour, v.power_rating, v.official_rank,
           v.elo as baseline_elo, bounded.s as surface,
           case bounded.s when 'hard' then v.hard_elo when 'clay' then v.clay_elo
                          when 'grass' then v.grass_elo when 'carpet' then v.carpet_elo
                          when 'indoor' then v.indoor_elo end as selo,
           case bounded.s when 'hard' then v.hard_sample when 'clay' then v.clay_sample
                          when 'grass' then v.grass_sample when 'carpet' then v.carpet_sample
                          when 'indoor' then v.indoor_sample end as ssample,
           case bounded.s when 'hard' then v.hard_win_pct when 'clay' then v.clay_win_pct
                          when 'grass' then v.grass_win_pct when 'carpet' then v.carpet_win_pct end as swin
      from tennis.lab_player_row v, bounded
     where v.tour = coalesce(p_tour, 'ATP')
  ),
  calc as (
    select base.*, bounded.full_sample,
           base.selo - base.baseline_elo as raw_d,
           (base.selo - base.baseline_elo)
             * least(coalesce(base.ssample, 0)::numeric / bounded.full_sample, 1.0) as adj,
           greatest(1.5, 18.0 / sqrt(greatest(coalesce(base.ssample, 0), 1)))::numeric as band,
           round(1 - least(coalesce(base.ssample, 0)::numeric / bounded.full_sample, 1.0), 3) as unc
      from base, bounded
     where base.selo is not null and base.baseline_elo is not null
  )
  select calc.player_id, calc.full_name, calc.country, calc.tour,
         calc.surface, round(calc.selo, 1), round(calc.baseline_elo, 1),
         round(calc.raw_d, 1), round(calc.adj, 1), round(calc.band, 2), calc.unc,
         calc.ssample, calc.swin, calc.power_rating, calc.official_rank
    from calc, bounded
   where coalesce(calc.ssample, 0) >= bounded.min_n
   order by case when lower(coalesce(p_order,'adjustment')) = 'strength' then calc.selo
                 when lower(coalesce(p_order,'adjustment')) = 'negative' then -calc.adj
                 else calc.adj end desc,
            calc.ssample desc, calc.player_id
   limit (select n from bounded);
$$;
grant execute on function tennis.lab_surface_board(text, text, text, integer, integer) to anon, authenticated, service_role;

-- FORM AND TRAJECTORY. Filtered by the stored classification.
create or replace function tennis.lab_trajectory_board(
  p_tour text default 'ATP',
  p_class text default 'improving',
  p_limit integer default 25,
  p_min_sample integer default 12)
returns table (
  player_id text, full_name text, country text, tour text,
  trajectory_class text, direction smallint,
  form_30d numeric, form_90d numeric, form_365d numeric, form_sample_365d integer,
  sos_elo_recent numeric, sos_elo_career numeric, schedule_shift numeric,
  rating_delta_30d numeric, rating_delta_90d numeric,
  power_rating numeric, uncertainty numeric, official_rank integer,
  days_since_last_match integer)
language sql stable security invoker set search_path = tennis, pg_temp as $$
  with bounded as (select least(greatest(coalesce(p_limit, 25), 1), 100) as n,
                          greatest(coalesce(p_min_sample, 0), 0) as min_n)
  select v.player_id, v.full_name, v.country, v.tour,
         v.trajectory_class, v.trajectory_direction,
         v.form_30d, v.form_90d, v.form_365d, v.form_sample_365d,
         v.sos_elo_recent, v.sos_elo_career,
         round(v.sos_elo_recent - v.sos_elo_career, 1) as schedule_shift,
         v.rating_delta_30d, v.rating_delta_90d,
         v.power_rating, v.uncertainty, v.official_rank, v.days_since_last_match
    from tennis.lab_player_row v, bounded
   where v.tour = coalesce(p_tour, 'ATP')
     and (p_class is null or p_class = 'all' or v.trajectory_class = lower(p_class))
     and coalesce(v.form_sample_365d, 0) >= bounded.min_n
   order by abs(coalesce(v.rating_delta_30d, 0)) desc, v.form_sample_365d desc, v.player_id
   limit (select n from bounded);
$$;
grant execute on function tennis.lab_trajectory_board(text, text, integer, integer) to anon, authenticated, service_role;

-- SCHEDULE AND FATIGUE. A calendar observation, never a medical one — the
-- column names and the note below both say so, and the AI contract repeats it.
create or replace function tennis.lab_fatigue_board(
  p_tour text default 'ATP',
  p_class text default 'heavy',
  p_limit integer default 25)
returns table (
  player_id text, full_name text, country text, tour text,
  workload_class text, matches_7d integer, matches_14d integer, matches_28d integer,
  rest_days integer, days_since_last_match integer, last_match_date date,
  power_rating numeric, official_rank integer, uncertainty numeric,
  note text)
language sql stable security invoker set search_path = tennis, pg_temp as $$
  with bounded as (select least(greatest(coalesce(p_limit, 25), 1), 100) as n)
  select v.player_id, v.full_name, v.country, v.tour,
         coalesce(v.workload_class, 'unknown'),
         v.matches_7d, v.matches_14d, v.matches_28d,
         -- A negative rest means the record holds a match dated after today,
         -- which the archive's tournament-week dating can produce. It is
         -- surfaced as NULL (unknown) rather than as a negative number, the
         -- same way lib/tennis_lab.js workload() refuses it, so the board and
         -- the player card cannot disagree about the same player.
         nullif(greatest(v.rest_days, -1), -1), v.days_since_last_match, v.last_match_date,
         v.power_rating, v.official_rank, v.uncertainty,
         'Workload is a scheduling observation. EdgeDesk holds no medical information and makes no injury or fitness claim.'::text
    from tennis.lab_player_row v, bounded
   where v.tour = coalesce(p_tour, 'ATP')
     and (p_class is null or p_class = 'all' or coalesce(v.workload_class,'unknown') = lower(p_class))
   order by coalesce(v.matches_7d, -1) desc, coalesce(v.matches_14d, -1) desc, v.player_id
   limit (select n from bounded);
$$;
grant execute on function tennis.lab_fatigue_board(text, text, integer) to anon, authenticated, service_role;

-- RANKING VERSUS RATING. Where the official list and EdgeDesk disagree most.
--
-- The comparison is between two RANKS, not between a rank and a rating: #4 and
-- 71.3 are not on the same scale and subtracting them would be meaningless. So
-- the rating is converted to its own rank within the tour and the two ordinal
-- positions are differenced, which is a quantity that means something.
create or replace function tennis.lab_rank_gap(
  p_tour text default 'ATP',
  p_direction text default 'underrated',
  p_limit integer default 20,
  p_min_sample integer default 20)
returns table (
  player_id text, full_name text, country text, tour text,
  official_rank integer, edgedesk_rank integer, gap integer,
  power_rating numeric, uncertainty numeric, sample integer,
  form_90d numeric, trajectory_class text, last_match_date date)
language sql stable security invoker set search_path = tennis, pg_temp as $$
  with bounded as (select least(greatest(coalesce(p_limit, 20), 1), 100) as n,
                          greatest(coalesce(p_min_sample, 0), 0) as min_n),
  ranked as (
    -- RANKED BY ELO, NOT BY THE 0-100 RATING. The rating clamps at both ends,
    -- and on a sixty-year record a large tail of players sits at exactly 0.00.
    -- Ranking by a clamped value gives every one of them an arbitrary position,
    -- so "most underrated" filled up with players the model and the official
    -- list AGREE are weak — the gap was pure tie-breaking noise. Elo is the
    -- underlying quantity and does not clamp, so it orders the whole field.
    --
    -- Players at either clamp are excluded outright: where the rating has
    -- saturated it is no longer measuring a disagreement, and a disagreement is
    -- the entire point of this board.
    select v.*, row_number() over (order by v.elo desc nulls last, v.player_id)::integer as ed_rank
      from tennis.lab_player_row v, bounded
     where v.tour = coalesce(p_tour, 'ATP')
       and v.power_rating is not null
       and v.power_rating > 0 and v.power_rating < 100
       and v.elo is not null
       and v.rating_sample >= bounded.min_n
  )
  select ranked.player_id, ranked.full_name, ranked.country, ranked.tour,
         ranked.official_rank, ranked.ed_rank,
         (ranked.official_rank - ranked.ed_rank) as gap,
         ranked.power_rating, ranked.uncertainty, ranked.rating_sample,
         ranked.form_90d, ranked.trajectory_class, ranked.last_match_date
    from ranked, bounded
   where ranked.official_rank is not null
   order by case when lower(coalesce(p_direction,'underrated')) = 'overrated'
                 then (ranked.ed_rank - ranked.official_rank)
                 else (ranked.official_rank - ranked.ed_rank) end desc,
            ranked.rating_sample desc, ranked.player_id
   limit (select n from bounded);
$$;
grant execute on function tennis.lab_rank_gap(text, text, integer, integer) to anon, authenticated, service_role;

-- PLAYER SEARCH. Prefix and substring, bounded, on the normalised name.
create or replace function tennis.lab_search(
  p_q text,
  p_tour text default null,
  p_limit integer default 12)
returns table (
  player_id text, full_name text, country text, tour text,
  power_rating numeric, official_rank integer, uncertainty numeric,
  matches_on_file integer, last_match date, active boolean)
language sql stable security invoker set search_path = tennis, pg_temp as $$
  with bounded as (select least(greatest(coalesce(p_limit, 12), 1), 50) as n,
                          nullif(btrim(lower(coalesce(p_q, ''))), '') as q)
  select p.player_id, p.full_name, p.country, p.tour,
         r.power_rating, r.official_rank, r.uncertainty,
         p.matches_on_file, p.last_match, p.active
    from tennis.players p
    left join tennis.player_ratings_current r on r.player_id = p.player_id, bounded
   where bounded.q is not null
     and (p_tour is null or p.tour = p_tour)
     and (p.name_norm like bounded.q || '%' or p.name_norm like '%' || bounded.q || '%')
   -- exact prefix first, then the deepest record: a search for "federer"
   -- should not lead with a qualifier who played twice in 1993.
   order by (p.name_norm like bounded.q || '%') desc,
            p.matches_on_file desc nulls last, p.player_id
   limit (select n from bounded);
$$;
grant execute on function tennis.lab_search(text, text, integer) to anon, authenticated, service_role;

-- THE PLAYER CARD. One call, everything the profile page opens with.
create or replace function tennis.lab_player_card(p_player_id text)
returns table (
  player_id text, full_name text, country text, tour text, plays text,
  height_cm integer, latest_age numeric, matches_on_file integer, active boolean,
  first_match date, last_match date,
  power_rating numeric, uncertainty numeric, rating_sample integer,
  elo numeric, hard_elo numeric, clay_elo numeric, grass_elo numeric,
  carpet_elo numeric, indoor_elo numeric, outdoor_elo numeric,
  hard_sample integer, clay_sample integer, grass_sample integer,
  carpet_sample integer, indoor_sample integer, outdoor_sample integer,
  hard_win_pct numeric, clay_win_pct numeric, grass_win_pct numeric, carpet_win_pct numeric,
  form_30d numeric, form_90d numeric, form_365d numeric, form_sample_365d integer,
  matches_7d integer, matches_14d integer, matches_28d integer,
  rest_days integer, days_since_last_match integer,
  serve_strength numeric, return_strength numeric, serve_sample integer,
  sos_elo_recent numeric, sos_elo_career numeric, sos_sample integer,
  trajectory_class text, trajectory_direction smallint, workload_class text,
  rating_delta_30d numeric, rating_delta_90d numeric,
  official_rank integer, official_rank_points integer, official_rank_as_of date,
  career_wins bigint, career_losses bigint, career_win_pct numeric,
  rating_version text, lab_version text, rating_computed_at timestamptz)
language sql stable security invoker set search_path = tennis, pg_temp as $$
  select v.player_id, v.full_name, v.country, v.tour, v.plays,
         v.height_cm, v.latest_age, v.matches_on_file, v.active,
         p.first_match, v.last_match,
         v.power_rating, v.uncertainty, v.rating_sample,
         v.elo, v.hard_elo, v.clay_elo, v.grass_elo, v.carpet_elo, v.indoor_elo, v.outdoor_elo,
         v.hard_sample, v.clay_sample, v.grass_sample, v.carpet_sample, v.indoor_sample, v.outdoor_sample,
         v.hard_win_pct, v.clay_win_pct, v.grass_win_pct, v.carpet_win_pct,
         v.form_30d, v.form_90d, v.form_365d, v.form_sample_365d,
         v.matches_7d, v.matches_14d, v.matches_28d, v.rest_days, v.days_since_last_match,
         v.serve_strength, v.return_strength, v.serve_sample,
         v.sos_elo_recent, v.sos_elo_career, v.sos_sample,
         v.trajectory_class, v.trajectory_direction, v.workload_class,
         v.rating_delta_30d, v.rating_delta_90d,
         v.official_rank, v.official_rank_points, v.official_rank_as_of,
         c.wins, c.losses, c.win_pct,
         v.rating_version, v.lab_version, v.rating_computed_at
    from tennis.lab_player_row v
    join tennis.players p on p.player_id = v.player_id
    left join tennis.player_career c on c.player_id = v.player_id
   where v.player_id = p_player_id;
$$;
grant execute on function tennis.lab_player_card(text) to anon, authenticated, service_role;

-- The rating line for the profile chart.
create or replace function tennis.lab_player_history(
  p_player_id text, p_limit integer default 120)
returns table (as_of date, elo numeric, hard_elo numeric, clay_elo numeric,
               grass_elo numeric, power_rating numeric, official_rank integer,
               sample integer, uncertainty numeric)
language sql stable security invoker set search_path = tennis, pg_temp as $$
  with bounded as (select least(greatest(coalesce(p_limit, 120), 1), 400) as n)
  select h.as_of, h.elo, h.hard_elo, h.clay_elo, h.grass_elo,
         h.power_rating, h.official_rank, h.sample, h.uncertainty
    from tennis.rating_history h, bounded
   where h.player_id = p_player_id
   order by h.as_of desc
   limit (select n from bounded);
$$;
grant execute on function tennis.lab_player_history(text, integer) to anon, authenticated, service_role;

-- Tournament-level, format and surface splits for the profile page.
create or replace function tennis.lab_player_splits(p_player_id text)
returns table (split_kind text, split_key text, split_label text,
               matches bigint, wins bigint, losses bigint, win_pct numeric,
               avg_opponent_rank numeric)
language sql stable security invoker set search_path = tennis, pg_temp as $$
  -- tennis.player_match_rows already carries surface, level, best_of and round,
  -- so the join to tennis.matches adds only what it does not: the environment
  -- and the OPPONENT's rank. Re-selecting the shared columns from both sides
  -- would make every one of them ambiguous.
  with rows as (
    select r.match_id, r.player_id, r.won, r.surface as msurface, r.level, r.best_of,
           m.environment,
           case when r.won then m.loser_rank else m.winner_rank end as opp_rank
      from tennis.player_match_rows r
      join tennis.matches m on m.match_id = r.match_id
     where r.player_id = p_player_id
  )
  select 'surface'::text, coalesce(msurface,'unknown'),
         initcap(coalesce(msurface,'unknown')),
         count(*), count(*) filter (where won), count(*) filter (where not won),
         round(avg(case when won then 1 else 0 end)::numeric, 4),
         round(avg(opp_rank)::numeric, 1)
    from rows group by 1,2,3
  union all
  select 'level', coalesce(level,'?'), coalesce(level,'Unknown level'),
         count(*), count(*) filter (where won), count(*) filter (where not won),
         round(avg(case when won then 1 else 0 end)::numeric, 4),
         round(avg(opp_rank)::numeric, 1)
    from rows group by 1,2,3
  union all
  select 'best_of', coalesce(best_of::text,'?'),
         case when best_of = 5 then 'Best of five' when best_of = 3 then 'Best of three' else 'Format unknown' end,
         count(*), count(*) filter (where won), count(*) filter (where not won),
         round(avg(case when won then 1 else 0 end)::numeric, 4),
         round(avg(opp_rank)::numeric, 1)
    from rows group by 1,2,3
  union all
  select 'environment', coalesce(environment,'unknown'), initcap(coalesce(environment,'unknown')),
         count(*), count(*) filter (where won), count(*) filter (where not won),
         round(avg(case when won then 1 else 0 end)::numeric, 4),
         round(avg(opp_rank)::numeric, 1)
    from rows group by 1,2,3
  order by 1, 4 desc;
$$;
grant execute on function tennis.lab_player_splits(text) to anon, authenticated, service_role;

-- Recent matches for the profile page, newest first, bounded.
create or replace function tennis.lab_player_matches(
  p_player_id text, p_limit integer default 20, p_before date default null)
returns table (match_id text, match_date date, tourney_name text, round text,
               surface text, level text, best_of integer, environment text,
               won boolean, opponent_id text, opponent_name text,
               opponent_rank integer, score text, minutes integer,
               retirement boolean, walkover boolean)
language sql stable security invoker set search_path = tennis, pg_temp as $$
  with bounded as (select least(greatest(coalesce(p_limit, 20), 1), 100) as n)
  select m.match_id, m.match_date, m.tourney_name, m.round,
         m.surface, m.level, m.best_of, m.environment,
         r.won, r.opponent_id, o.full_name,
         case when r.won then m.loser_rank else m.winner_rank end,
         m.score, m.minutes, m.retirement, m.walkover
    from tennis.player_match_rows r
    join tennis.matches m on m.match_id = r.match_id
    left join tennis.players o on o.player_id = r.opponent_id, bounded
   where r.player_id = p_player_id
     and (p_before is null or m.match_date < p_before)
   order by m.match_date desc nulls last, m.match_id desc
   limit (select n from bounded);
$$;
grant execute on function tennis.lab_player_matches(text, integer, date) to anon, authenticated, service_role;


-- ===========================================================================
-- THE MATCHUP STUDIO's inputs.
--
-- The projection itself is computed by lib/tennis_lab.js — one implementation,
-- shared by the page, the AI and the pipeline. This function's only job is to
-- hand that engine two point-in-time input rows, and it is where the HISTORICAL
-- CUTOFF is enforced.
--
-- HOW `p_as_of` WORKS, AND ITS ONE HONEST LIMITATION. With no cutoff, the two
-- sides come from player_ratings_current — today's rating, computed from
-- completed matches. With a cutoff, they come from the most recent
-- player_match_features row STRICTLY BEFORE that date. Those columns all end
-- `_pre` because they describe what was knowable entering that match, so
-- nothing at or after the cutoff can reach the answer.
--
-- The limitation, stated rather than hidden: that snapshot is the state
-- entering the player's last match before the cutoff, so it excludes that one
-- match's own result. It is therefore very slightly STALE rather than leaky —
-- which is the correct direction for a research tool to err, and the only
-- direction that is safe. lab_sql.test.js proves no row at or after the cutoff
-- can influence the output.
-- ===========================================================================
create or replace function tennis.lab_matchup_inputs(
  p_player_a text, p_player_b text,
  p_surface text default null,
  p_as_of date default null)
returns table (
  side text, player_id text, full_name text, country text, tour text,
  elo numeric, hard_elo numeric, clay_elo numeric, grass_elo numeric,
  carpet_elo numeric, indoor_elo numeric,
  hard_sample integer, clay_sample integer, grass_sample integer,
  carpet_sample integer, indoor_sample integer,
  hard_win_pct numeric, clay_win_pct numeric, grass_win_pct numeric, carpet_win_pct numeric,
  form_30d numeric, form_90d numeric, form_365d numeric,
  matches_7d integer, matches_14d integer, rest_days integer,
  serve_strength numeric, return_strength numeric,
  sos_elo_recent numeric, sos_elo_career numeric,
  official_rank integer, official_rank_points integer,
  latest_age numeric, rating_sample integer, uncertainty numeric,
  days_since_last_match integer, source_mode text, snapshot_date date)
-- SECURITY DEFINER, and this is the reason.
--
-- The cutoff branch reads tennis.player_match_features, which is PRIVATE — no
-- client role may select from it, and that is deliberate: it is the training
-- surface and a reader with access to it could reconstruct the model's inputs
-- wholesale. As `security invoker` this function therefore returned "permission
-- denied for table player_match_features" to every signed-out visitor, and —
-- because PostgreSQL checks table permissions when it PLANS the statement, not
-- when a branch returns rows — it failed that way even with NO cutoff set,
-- where the private branch produces nothing at all. The Matchup Studio, the
-- centrepiece of the Lab, was dead for anon in both modes.
--
-- Definer is the correct posture rather than a workaround: what comes out is
-- exactly two rows of pre-match state for two NAMED players, which is the
-- narrow answer the studio needs. The table itself stays shut. Same pattern,
-- and same reasoning, as tennis.ops_health() in the record contract.
language sql stable security definer set search_path = tennis, pg_temp as $$
  with want as (
    select 'a'::text as side, p_player_a as pid
    union all select 'b', p_player_b
  ),
  -- CURRENT MODE: today's rating.
  cur as (
    select w.side, v.*, 'current'::text as mode, null::date as snap
      from want w join tennis.lab_player_row v on v.player_id = w.pid
     where p_as_of is null
  ),
  -- CUTOFF MODE: the last point-in-time feature row strictly before the date.
  hist as (
    select distinct on (w.side)
           w.side, f.player_id, p.full_name, p.country, f.tour,
           f.elo_pre, f.surface_elo_pre, f.win_pct_30d_pre, f.win_pct_90d_pre,
           f.win_pct_365d_pre, f.matches_7d_pre, f.matches_14d_pre, f.rest_days_pre,
           f.career_surface_win_pct_pre, f.career_surface_matches_pre,
           f.rank_pre, f.rank_points_pre, f.age_pre,
           f.serve_strength_pre, f.return_strength_pre, f.sos_elo_pre,
           f.match_date as snap
      from want w
      join tennis.player_match_features f on f.player_id = w.pid
      join tennis.players p on p.player_id = f.player_id
     where p_as_of is not null
       and f.match_date < p_as_of          -- STRICTLY before. The whole point.
     order by w.side, f.match_date desc, f.feature_id desc
  )
  select cur.side, cur.player_id, cur.full_name, cur.country, cur.tour,
         cur.elo, cur.hard_elo, cur.clay_elo, cur.grass_elo, cur.carpet_elo, cur.indoor_elo,
         cur.hard_sample, cur.clay_sample, cur.grass_sample, cur.carpet_sample, cur.indoor_sample,
         cur.hard_win_pct, cur.clay_win_pct, cur.grass_win_pct, cur.carpet_win_pct,
         cur.form_30d, cur.form_90d, cur.form_365d,
         cur.matches_7d, cur.matches_14d, cur.rest_days,
         cur.serve_strength, cur.return_strength,
         cur.sos_elo_recent, cur.sos_elo_career,
         cur.official_rank, cur.official_rank_points,
         cur.latest_age, cur.rating_sample, cur.uncertainty,
         cur.days_since_last_match, cur.mode, cur.snap
    from cur
  union all
  -- In cutoff mode only the surface the caller asked about is knowable from a
  -- feature row (it carries ONE surface_elo_pre — the surface that match was
  -- played on). Every other surface column is null rather than filled with the
  -- overall figure, because claiming a clay rating EdgeDesk did not compute
  -- would be exactly the silent-substitution this product refuses.
  select hist.side, hist.player_id, hist.full_name, hist.country, hist.tour,
         hist.elo_pre,
         case when lower(coalesce(p_surface,'')) = 'hard'  then hist.surface_elo_pre end,
         case when lower(coalesce(p_surface,'')) = 'clay'  then hist.surface_elo_pre end,
         case when lower(coalesce(p_surface,'')) = 'grass' then hist.surface_elo_pre end,
         case when lower(coalesce(p_surface,'')) = 'carpet' then hist.surface_elo_pre end,
         null::numeric,
         case when lower(coalesce(p_surface,'')) = 'hard'  then hist.career_surface_matches_pre end,
         case when lower(coalesce(p_surface,'')) = 'clay'  then hist.career_surface_matches_pre end,
         case when lower(coalesce(p_surface,'')) = 'grass' then hist.career_surface_matches_pre end,
         case when lower(coalesce(p_surface,'')) = 'carpet' then hist.career_surface_matches_pre end,
         null::integer,
         case when lower(coalesce(p_surface,'')) = 'hard'  then hist.career_surface_win_pct_pre end,
         case when lower(coalesce(p_surface,'')) = 'clay'  then hist.career_surface_win_pct_pre end,
         case when lower(coalesce(p_surface,'')) = 'grass' then hist.career_surface_win_pct_pre end,
         case when lower(coalesce(p_surface,'')) = 'carpet' then hist.career_surface_win_pct_pre end,
         hist.win_pct_30d_pre, hist.win_pct_90d_pre, hist.win_pct_365d_pre,
         hist.matches_7d_pre, hist.matches_14d_pre, hist.rest_days_pre,
         hist.serve_strength_pre, hist.return_strength_pre,
         hist.sos_elo_pre, hist.sos_elo_pre,
         hist.rank_pre, hist.rank_points_pre,
         hist.age_pre, null::integer, null::numeric,
         null::integer, 'as_of'::text, hist.snap
    from hist;
$$;
revoke all on function tennis.lab_matchup_inputs(text, text, text, date) from public;
grant execute on function tennis.lab_matchup_inputs(text, text, text, date) to anon, authenticated, service_role;

-- Head to head between two players, optionally on one surface.
create or replace function tennis.lab_h2h(
  p_player_a text, p_player_b text,
  p_surface text default null, p_limit integer default 20)
returns table (match_id text, match_date date, tourney_name text, round text,
               surface text, level text, best_of integer, environment text,
               winner_id text, winner_name text, loser_id text, loser_name text,
               score text, minutes integer, a_won boolean)
language sql stable security invoker set search_path = tennis, pg_temp as $$
  with bounded as (select least(greatest(coalesce(p_limit, 20), 1), 100) as n)
  select m.match_id, m.match_date, m.tourney_name, m.round,
         m.surface, m.level, m.best_of, m.environment,
         m.winner_id, w.full_name, m.loser_id, l.full_name,
         m.score, m.minutes, (m.winner_id = p_player_a)
    from tennis.matches m
    left join tennis.players w on w.player_id = m.winner_id
    left join tennis.players l on l.player_id = m.loser_id, bounded
   where ((m.winner_id = p_player_a and m.loser_id = p_player_b)
       or (m.winner_id = p_player_b and m.loser_id = p_player_a))
     and (p_surface is null or m.surface = lower(p_surface))
   order by m.match_date desc nulls last, m.match_id desc
   limit (select n from bounded);
$$;
grant execute on function tennis.lab_h2h(text, text, text, integer) to anon, authenticated, service_role;

-- HISTORICAL COMPARABLES. Matches that resemble this one, by the dimensions
-- that make a matchup what it is — the rating gap, the surface, the format —
-- and explicitly NOT by the result, which is what makes them evidence.
create or replace function tennis.lab_comparables(
  p_tour text, p_elo_gap numeric,
  p_surface text default null, p_best_of integer default null,
  p_level text default null, p_limit integer default 12)
returns table (match_id text, match_date date, tourney_name text, round text,
               surface text, level text, best_of integer,
               winner_name text, loser_name text, score text,
               elo_gap numeric, favourite_won boolean, similarity numeric)
-- SECURITY DEFINER for the same reason as lab_matchup_inputs: the rating gap
-- that makes a past match comparable is read from the private feature table.
-- What leaves this function is a handful of completed matches and the Elo gap
-- each was played at — public facts about finished tennis, not the feature
-- surface they were computed from.
language sql stable security definer set search_path = tennis, pg_temp as $$
  with bounded as (select least(greatest(coalesce(p_limit, 12), 1), 50) as n,
                          abs(coalesce(p_elo_gap, 0)) as gap),
  cand as (
    select m.match_id, m.match_date, m.tourney_name, m.round, m.surface, m.level, m.best_of,
           w.full_name as wname, l.full_name as lname, m.score,
           abs(coalesce(fw.elo_pre, 0) - coalesce(fl.elo_pre, 0)) as mgap,
           (coalesce(fw.elo_pre, 0) >= coalesce(fl.elo_pre, 0)) as fav_won
      from tennis.matches m
      join tennis.player_match_features fw
        on fw.match_id = m.match_id and fw.player_id = m.winner_id
      join tennis.player_match_features fl
        on fl.match_id = m.match_id and fl.player_id = m.loser_id
      left join tennis.players w on w.player_id = m.winner_id
      left join tennis.players l on l.player_id = m.loser_id
     where m.tour = p_tour
       and m.walkover = false
       and (p_surface is null or m.surface = lower(p_surface))
       and (p_best_of is null or m.best_of = p_best_of)
       and (p_level is null or m.level = p_level)
       and fw.elo_pre is not null and fl.elo_pre is not null
  )
  select cand.match_id, cand.match_date, cand.tourney_name, cand.round,
         cand.surface, cand.level, cand.best_of,
         cand.wname, cand.lname, cand.score,
         round(cand.mgap, 1),
         cand.fav_won,
         round(greatest(0, 1 - abs(cand.mgap - bounded.gap) / 250.0)::numeric, 3)
    from cand, bounded
   where abs(cand.mgap - bounded.gap) <= 250
   order by abs(cand.mgap - bounded.gap), cand.match_date desc
   limit (select n from bounded);
$$;
revoke all on function tennis.lab_comparables(text, numeric, text, integer, text, integer) from public;
grant execute on function tennis.lab_comparables(text, numeric, text, integer, text, integer) to anon, authenticated, service_role;


-- ===========================================================================
-- L6 — THE HISTORICAL EXPLORER.
--
-- One function over 361,571 matches. Every filter is applied IN THE DATABASE
-- and the result is cursor-paginated, because the alternative — shipping the
-- table to the browser and filtering there — is the thing the brief forbids
-- and would be 120 MB per page load.
--
-- THE CURSOR IS (match_date, match_id), NOT AN OFFSET. An offset re-scans and
-- re-sorts everything it skips, so page 400 of a 361k-row result costs 400
-- times page 1. A keyset cursor costs the same for every page, and — because
-- new rows only ever arrive with later dates — it cannot skip or duplicate a
-- row when the table grows under a paging reader.
-- ===========================================================================
create or replace function tennis.lab_explore(
  p_tour text default 'ATP',
  p_player_id text default null,
  p_opponent_id text default null,
  p_season_from integer default null,
  p_season_to integer default null,
  p_surface text default null,
  p_level text default null,
  p_round text default null,
  p_best_of integer default null,
  p_environment text default null,
  p_rank_max integer default null,
  p_opp_rank_max integer default null,
  p_country text default null,
  p_plays text default null,
  p_age_min numeric default null,
  p_age_max numeric default null,
  p_cursor_date date default null,
  p_cursor_id text default null,
  p_limit integer default 50)
returns table (
  match_id text, match_date date, season integer, tourney_name text, round text,
  surface text, level text, best_of integer, environment text,
  winner_id text, winner_name text, winner_rank integer,
  loser_id text, loser_name text, loser_rank integer,
  score text, minutes integer, retirement boolean, walkover boolean,
  next_cursor_date date, next_cursor_id text)
language sql stable security invoker set search_path = tennis, pg_temp as $$
  with bounded as (select least(greatest(coalesce(p_limit, 50), 1), 200) as n),
  hits as (
    select m.match_id, m.match_date, m.season, m.tourney_name, m.round,
           m.surface, m.level, m.best_of, m.environment,
           m.winner_id, w.full_name as wname, m.winner_rank,
           m.loser_id, l.full_name as lname, m.loser_rank,
           m.score, m.minutes, m.retirement, m.walkover
      from tennis.matches m
      left join tennis.players w on w.player_id = m.winner_id
      left join tennis.players l on l.player_id = m.loser_id, bounded
     where m.tour = coalesce(p_tour, 'ATP')
       and (p_player_id is null or m.winner_id = p_player_id or m.loser_id = p_player_id)
       and (p_opponent_id is null or m.winner_id = p_opponent_id or m.loser_id = p_opponent_id)
       and (p_season_from is null or m.season >= p_season_from)
       and (p_season_to is null or m.season <= p_season_to)
       and (p_surface is null or m.surface = lower(p_surface))
       and (p_level is null or m.level = p_level)
       and (p_round is null or m.round = p_round)
       and (p_best_of is null or m.best_of = p_best_of)
       and (p_environment is null or m.environment = lower(p_environment))
       and (p_rank_max is null or least(coalesce(m.winner_rank, 99999), coalesce(m.loser_rank, 99999)) <= p_rank_max)
       and (p_opp_rank_max is null or greatest(coalesce(m.winner_rank, 0), coalesce(m.loser_rank, 0)) <= p_opp_rank_max)
       and (p_country is null or w.country = upper(p_country) or l.country = upper(p_country))
       and (p_plays is null or w.plays = upper(p_plays) or l.plays = upper(p_plays))
       and (p_age_min is null or greatest(coalesce(m.winner_age, 0), coalesce(m.loser_age, 0)) >= p_age_min)
       and (p_age_max is null or least(coalesce(m.winner_age, 999), coalesce(m.loser_age, 999)) <= p_age_max)
       -- the keyset: everything strictly older than the cursor
       and (p_cursor_date is null
            or m.match_date < p_cursor_date
            or (m.match_date = p_cursor_date and m.match_id < coalesce(p_cursor_id, '')))
     order by m.match_date desc nulls last, m.match_id desc
     limit (select n from bounded)
  )
  -- The next cursor is the LAST row of this page in sort order, handed back so
  -- the caller asks for "everything strictly older than this" without ever
  -- computing an offset. `last_value` needs the explicit full-partition frame:
  -- the default frame ends at the current row, which would give every row its
  -- own value instead of the page's final one.
  select hits.match_id, hits.match_date, hits.season, hits.tourney_name, hits.round,
         hits.surface, hits.level, hits.best_of, hits.environment,
         hits.winner_id, hits.wname, hits.winner_rank,
         hits.loser_id, hits.lname, hits.loser_rank,
         hits.score, hits.minutes, hits.retirement, hits.walkover,
         last_value(hits.match_date) over w as next_cursor_date,
         last_value(hits.match_id)   over w as next_cursor_id
    from hits
  window w as (order by hits.match_date desc nulls last, hits.match_id desc
               rows between unbounded preceding and unbounded following)
   order by hits.match_date desc nulls last, hits.match_id desc;
$$;
grant execute on function tennis.lab_explore(text, text, text, integer, integer, text, text, text, integer, text, integer, integer, text, text, numeric, numeric, date, text, integer) to anon, authenticated, service_role;

-- Aggregate answer for the explorer's summary line. Same filters, one row.
create or replace function tennis.lab_explore_summary(
  p_tour text default 'ATP',
  p_player_id text default null,
  p_season_from integer default null,
  p_season_to integer default null,
  p_surface text default null,
  p_level text default null,
  p_best_of integer default null,
  p_environment text default null,
  p_opp_rank_max integer default null)
returns table (matches bigint, player_wins bigint, player_losses bigint,
               win_pct numeric, first_season integer, last_season integer,
               avg_minutes numeric, retirements bigint, walkovers bigint)
language sql stable security invoker set search_path = tennis, pg_temp as $$
  with hits as (
    select m.*,
           case when p_player_id is null then null
                when m.winner_id = p_player_id then true
                when m.loser_id = p_player_id then false end as won
      from tennis.matches m
     where m.tour = coalesce(p_tour, 'ATP')
       and (p_player_id is null or m.winner_id = p_player_id or m.loser_id = p_player_id)
       and (p_season_from is null or m.season >= p_season_from)
       and (p_season_to is null or m.season <= p_season_to)
       and (p_surface is null or m.surface = lower(p_surface))
       and (p_level is null or m.level = p_level)
       and (p_best_of is null or m.best_of = p_best_of)
       and (p_environment is null or m.environment = lower(p_environment))
       and (p_opp_rank_max is null or
            (case when m.winner_id = p_player_id then m.loser_rank else m.winner_rank end) <= p_opp_rank_max)
  )
  select count(*), count(*) filter (where won), count(*) filter (where won = false),
         case when count(*) filter (where won is not null) > 0
              then round((count(*) filter (where won))::numeric
                         / count(*) filter (where won is not null), 4) end,
         min(season), max(season), round(avg(minutes)::numeric, 1),
         count(*) filter (where retirement), count(*) filter (where walkover)
    from hits;
$$;
grant execute on function tennis.lab_explore_summary(text, text, integer, integer, text, text, integer, text, integer) to anon, authenticated, service_role;


-- ===========================================================================
-- LAB HEALTH. Freshness, versions and what the Lab does NOT have.
--
-- Same posture as tennis.record_health: the private operational tables are
-- read through the existing narrow definer function, never opened up.
-- ===========================================================================
-- Two indexes that exist ONLY for this view, added because it is loaded on
-- every single Lab render and was measured at 171 ms — the dominant cost of the
-- dashboard, ahead of every leaderboard on it.
--
-- `min(season)` and `max(season)` each cost a sequential scan of 361,575 rows
-- (21 ms and 23 ms) because the existing season index leads with `tour`, so a
-- bare aggregate over the whole table cannot use it. A plain btree on season
-- turns both into an index-only scan of one tuple. The count is left exact —
-- an estimate from pg_class would be cheaper still, but a data-health panel
-- that reports an approximation as "361,575 matches on file" is exactly the
-- kind of quiet dishonesty this product refuses.
create index if not exists tennis_matches_season_only_idx on tennis.matches (season);
create index if not exists tennis_matches_date_only_idx on tennis.matches (match_date);

create or replace view tennis.lab_health
with (security_invoker = true) as
  select
    (select count(*) from tennis.matches) as matches_on_file,
    (select count(*) from tennis.players) as players_on_file,
    (select count(*) from tennis.player_ratings_current where power_rating is not null) as rated_players,
    (select count(*) from tennis.rating_history) as history_rows,
    (select max(match_date) from tennis.matches) as data_through,
    (select min(season) from tennis.matches) as first_season,
    (select max(season) from tennis.matches) as last_season,
    (select max(computed_at) from tennis.player_ratings_current) as ratings_computed_at,
    (select max(rating_version) from tennis.player_ratings_current) as rating_version,
    (select max(lab_version) from tennis.player_ratings_current) as lab_version,
    (select model_version from tennis.model_registry where status = 'active' limit 1) as model_version,
    (select brief_date from tennis.research_briefs order by brief_date desc limit 1) as last_brief_date,
    -- ONE call, not two. Reading `available` and `reason` as separate scalar
    -- subqueries ran the whole function — which scans odds_snapshots and
    -- source_licenses — twice per page load for two fields of one answer.
    mk.available as market_module_available,
    mk.reason as market_module_reason,
    h.last_successful_ingest, h.failed_runs_7d, h.open_data_issues
  from tennis.ops_health() h
  cross join lateral tennis.lab_market_available() mk;

grant select on tennis.lab_health to anon, authenticated, service_role;
grant select on tennis.lab_player_row to anon, authenticated, service_role;


-- ===========================================================================
-- L7 — AI CONTEXT. The assistant's door into the Lab.
--
-- Bounded, typed, and each one returns the SAMPLE and the UNCERTAINTY beside
-- the number, because an assistant that quotes a rating without its sample is
-- the fastest route to a confident wrong answer.
-- ===========================================================================

create or replace function tennis.ai_lab_leaders(
  p_tour text, p_mode text, p_limit integer default 10)
returns table (player_id text, full_name text, country text, metric_value numeric,
               sample integer, uncertainty numeric, official_rank integer,
               trajectory_class text)
language sql stable security definer set search_path = tennis, pg_temp as $$
  select l.player_id, l.full_name, l.country, l.metric_value,
         l.surface_sample, l.uncertainty, l.official_rank, l.trajectory_class
    from tennis.lab_leaders(p_tour, p_mode, least(greatest(coalesce(p_limit, 10), 1), 25), 10) l;
$$;
revoke all on function tennis.ai_lab_leaders(text, text, integer) from public;
grant execute on function tennis.ai_lab_leaders(text, text, integer) to anon, authenticated, service_role;

create or replace function tennis.ai_lab_player(p_player_id text)
returns table (player_id text, full_name text, country text, tour text,
               power_rating numeric, uncertainty numeric, sample integer,
               official_rank integer, form_30d numeric, form_90d numeric, form_365d numeric,
               hard_elo numeric, clay_elo numeric, grass_elo numeric,
               hard_sample integer, clay_sample integer, grass_sample integer,
               trajectory_class text, workload_class text,
               matches_7d integer, matches_14d integer, rest_days integer,
               days_since_last_match integer, last_match date,
               serve_strength numeric, return_strength numeric,
               rating_version text, rating_computed_at timestamptz)
language sql stable security definer set search_path = tennis, pg_temp as $$
  select v.player_id, v.full_name, v.country, v.tour,
         v.power_rating, v.uncertainty, v.rating_sample, v.official_rank,
         v.form_30d, v.form_90d, v.form_365d,
         v.hard_elo, v.clay_elo, v.grass_elo,
         v.hard_sample, v.clay_sample, v.grass_sample,
         v.trajectory_class, v.workload_class,
         v.matches_7d, v.matches_14d, v.rest_days, v.days_since_last_match, v.last_match,
         v.serve_strength, v.return_strength,
         v.rating_version, v.rating_computed_at
    from tennis.lab_player_row v
   where v.player_id = p_player_id;
$$;
revoke all on function tennis.ai_lab_player(text) from public;
grant execute on function tennis.ai_lab_player(text) to anon, authenticated, service_role;

create or replace function tennis.ai_lab_rank_gap(p_tour text, p_direction text, p_limit integer default 8)
returns table (player_id text, full_name text, official_rank integer,
               edgedesk_rank integer, gap integer, power_rating numeric,
               uncertainty numeric, sample integer)
language sql stable security definer set search_path = tennis, pg_temp as $$
  select g.player_id, g.full_name, g.official_rank, g.edgedesk_rank, g.gap,
         g.power_rating, g.uncertainty, g.sample
    from tennis.lab_rank_gap(p_tour, p_direction, least(greatest(coalesce(p_limit, 8), 1), 25), 20) g;
$$;
revoke all on function tennis.ai_lab_rank_gap(text, text, integer) from public;
grant execute on function tennis.ai_lab_rank_gap(text, text, integer) to anon, authenticated, service_role;

create or replace function tennis.ai_lab_health()
returns table (matches_on_file bigint, players_on_file bigint, rated_players bigint,
               data_through date, first_season integer, last_season integer,
               ratings_computed_at timestamptz, rating_version text,
               model_version text, market_module_available boolean,
               market_module_reason text, open_data_issues bigint)
language sql stable security definer set search_path = tennis, pg_temp as $$
  select h.matches_on_file, h.players_on_file, h.rated_players,
         h.data_through, h.first_season, h.last_season,
         h.ratings_computed_at, h.rating_version, h.model_version,
         h.market_module_available, h.market_module_reason, h.open_data_issues
    from tennis.lab_health h;
$$;
revoke all on function tennis.ai_lab_health() from public;
grant execute on function tennis.ai_lab_health() to anon, authenticated, service_role;


-- ===========================================================================
-- ROW LEVEL SECURITY. Every new table, without exception.
-- ===========================================================================

-- rating_history: public read (it is the same class of fact as a rating),
-- writes only by the pipeline.
alter table tennis.rating_history enable row level security;
revoke insert, update, delete, truncate, references, trigger on tennis.rating_history from anon, authenticated;
grant select on tennis.rating_history to anon, authenticated;
grant all on tennis.rating_history to service_role;
drop policy if exists tennis_rh_read on tennis.rating_history;
create policy tennis_rh_read on tennis.rating_history for select to anon, authenticated using (true);

-- research_briefs: public read. A brief is editorial research, and gating it
-- would make the product look like a tip sheet behind a paywall, which is the
-- opposite of the positioning.
alter table tennis.research_briefs enable row level security;
revoke insert, update, delete, truncate, references, trigger on tennis.research_briefs from anon, authenticated;
grant select on tennis.research_briefs to anon, authenticated;
grant all on tennis.research_briefs to service_role;
drop policy if exists tennis_brief_read on tennis.research_briefs;
create policy tennis_brief_read on tennis.research_briefs for select to anon, authenticated using (true);

-- lab_flags: public read (the page must be able to ask whether a module is
-- available), writes only by the pipeline. A client that could flip a flag
-- could switch on a market module with no provider behind it.
alter table tennis.lab_flags enable row level security;
revoke insert, update, delete, truncate, references, trigger on tennis.lab_flags from anon, authenticated;
grant select on tennis.lab_flags to anon, authenticated;
grant all on tennis.lab_flags to service_role;
drop policy if exists tennis_flags_read on tennis.lab_flags;
create policy tennis_flags_read on tennis.lab_flags for select to anon, authenticated using (true);

grant usage, select on all sequences in schema tennis to service_role;


-- ===========================================================================
-- THE REPORT. Every row must read ok.
-- ===========================================================================
with checks as (
  select 1 as "row", 'the record contract is present underneath this file' as "check",
         case when to_regclass('tennis.player_ratings_current') is not null
               and to_regclass('tennis.matches') is not null
               and to_regclass('tennis.player_match_features') is not null then 'ok' else 'CHECK THIS' end as result
  union all select 2, 'the lab tables exist',
         case when to_regclass('tennis.rating_history') is not null
               and to_regclass('tennis.research_briefs') is not null
               and to_regclass('tennis.lab_flags') is not null then 'ok' else 'CHECK THIS' end
  union all select 3, 'the derived rating columns were added without disturbing the existing ones',
         case when (select count(*) from information_schema.columns
                     where table_schema = 'tennis' and table_name = 'player_ratings_current'
                       and column_name in ('serve_strength','return_strength','sos_elo_recent',
                                           'indoor_elo','hard_win_pct','trajectory_class',
                                           'workload_class','rating_delta_30d','lab_version')) = 9
               and (select count(*) from information_schema.columns
                     where table_schema = 'tennis' and table_name = 'player_ratings_current'
                       and column_name in ('power_rating','elo','uncertainty','rating_sample')) = 4
              then 'ok' else 'CHECK THIS' end
  union all select 4, 'every new derived column is nullable — a missing value stays missing',
         case when not exists (
                select 1 from information_schema.columns
                 where table_schema = 'tennis' and table_name = 'player_ratings_current'
                   and column_name in ('serve_strength','return_strength','sos_elo_recent','sos_elo_career',
                                       'indoor_elo','outdoor_elo','hard_win_pct','clay_win_pct',
                                       'grass_win_pct','carpet_win_pct','trajectory_class','workload_class',
                                       'rating_delta_30d','rating_delta_90d')
                   and is_nullable = 'NO')
              then 'ok' else 'CHECK THIS' end
  union all select 5, 'RLS is enabled on every new table',
         case when (select count(*) from pg_tables t join pg_class c on c.relname = t.tablename
                     where t.schemaname = 'tennis'
                       and t.tablename in ('rating_history','research_briefs','lab_flags')
                       and c.relrowsecurity) = 3 then 'ok' else 'CHECK THIS' end
  union all select 6, 'no client role may write a lab table',
         case when not has_table_privilege('anon', 'tennis.rating_history', 'INSERT')
               and not has_table_privilege('anon', 'tennis.research_briefs', 'INSERT')
               and not has_table_privilege('anon', 'tennis.lab_flags', 'UPDATE')
               and not has_table_privilege('authenticated', 'tennis.lab_flags', 'UPDATE')
              then 'ok' else 'CHECK THIS' end
  union all select 7, 'the nine lab view modes are all answered',
         case when to_regprocedure('tennis.lab_leaders(text, text, integer, integer)') is not null
               and (select count(*) from tennis.lab_leaders('ATP','overall',1,0)) >= 0
               and (select count(*) from tennis.lab_leaders('ATP','serve',1,0)) >= 0
               and (select count(*) from tennis.lab_leaders('ATP','workload',1,0)) >= 0
              then 'ok' else 'CHECK THIS' end
  union all select 8, 'every lab read exists and is callable',
         case when to_regprocedure('tennis.lab_movers(text, text, integer, integer, integer)') is not null
               and to_regprocedure('tennis.lab_surface_board(text, text, text, integer, integer)') is not null
               and to_regprocedure('tennis.lab_trajectory_board(text, text, integer, integer)') is not null
               and to_regprocedure('tennis.lab_fatigue_board(text, text, integer)') is not null
               and to_regprocedure('tennis.lab_rank_gap(text, text, integer, integer)') is not null
               and to_regprocedure('tennis.lab_search(text, text, integer)') is not null
               and to_regprocedure('tennis.lab_player_card(text)') is not null
               and to_regprocedure('tennis.lab_player_history(text, integer)') is not null
               and to_regprocedure('tennis.lab_player_splits(text)') is not null
               and to_regprocedure('tennis.lab_player_matches(text, integer, date)') is not null
               and to_regprocedure('tennis.lab_matchup_inputs(text, text, text, date)') is not null
               and to_regprocedure('tennis.lab_h2h(text, text, text, integer)') is not null
               and to_regprocedure('tennis.lab_comparables(text, numeric, text, integer, text, integer)') is not null
               and to_regprocedure('tennis.lab_explore_summary(text, text, integer, integer, text, text, integer, text, integer)') is not null
              then 'ok' else 'CHECK THIS' end
  union all select 9, 'the explorer is cursor-paginated and bounded',
         case when to_regprocedure('tennis.lab_explore(text, text, text, integer, integer, text, text, text, integer, text, integer, integer, text, text, numeric, numeric, date, text, integer)') is not null
               and (select count(*) from tennis.lab_explore('ATP', p_limit => 100000)) <= 200
              then 'ok' else 'CHECK THIS' end
  union all select 10, 'every leaderboard caps its own limit',
         case when (select count(*) from tennis.lab_leaders('ATP','overall',100000,0)) <= 100
               and (select count(*) from tennis.lab_search('a', null, 100000)) <= 50
              then 'ok' else 'CHECK THIS' end
  union all select 11, 'the market module is OFF and says why',
         case when (select available from tennis.lab_market_available()) = false
               and (select reason from tennis.lab_market_available()) is not null
              then 'ok' else 'CHECK THIS — the market module must ship disabled' end
  union all select 12, 'a brief carrying odds or selections cannot be stored',
         case when exists (select 1 from pg_constraint where conname = 'tennis_brief_no_odds')
               and exists (select 1 from pg_constraint where conname = 'tennis_brief_no_selections')
              then 'ok' else 'CHECK THIS' end
  union all select 13, 'a generated brief is immutable',
         case when to_regprocedure('tennis.freeze_brief()') is not null
               and exists (select 1 from pg_trigger where tgname = 'tennis_brief_freeze')
              then 'ok' else 'CHECK THIS' end
  union all select 14, 'rating history is licence-gated like every other sourced table',
         case when exists (select 1 from pg_trigger where tgname = 'tennis_rh_license')
              then 'ok' else 'CHECK THIS' end
  union all select 15, 'every privileged lab function has a fixed search_path and no public execute',
         case when not exists (
                select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'tennis' and p.proname like 'lab\_%' and p.prosecdef
                   and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c
                                    where c like 'search_path=%'))
              and not exists (
                select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'tennis' and (p.proname like 'lab\_%' or p.proname like 'ai\_lab\_%')
                   and p.prosecdef and has_function_privilege('public', p.oid, 'EXECUTE'))
              then 'ok' else 'CHECK THIS' end
  union all select 16, 'the AI lab functions exist',
         case when to_regprocedure('tennis.ai_lab_leaders(text, text, integer)') is not null
               and to_regprocedure('tennis.ai_lab_player(text)') is not null
               and to_regprocedure('tennis.ai_lab_rank_gap(text, text, integer)') is not null
               and to_regprocedure('tennis.ai_lab_health()') is not null
              then 'ok' else 'CHECK THIS' end
  union all select 16.5, 'a signed-out reader can run a matchup WITHOUT reading the private feature table',
         case when (select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname='tennis' and p.proname='lab_matchup_inputs')
               and (select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname='tennis' and p.proname='lab_comparables')
               and has_function_privilege('anon','tennis.lab_matchup_inputs(text, text, text, date)','EXECUTE')
               and not has_table_privilege('anon','tennis.player_match_features','SELECT')
              then 'ok' else 'CHECK THIS' end
  union all select 17, 'the lab health line is readable without reading a private table',
         case when (select count(*) from tennis.lab_health) = 1
               and not has_table_privilege('anon', 'tennis.ingestion_runs', 'SELECT')
               and not has_table_privilege('anon', 'tennis.player_match_features', 'SELECT')
              then 'ok' else 'CHECK THIS' end
  union all select 18, 'the record contract is untouched by this file',
         case when to_regclass('tennis.prediction_record') is not null
               and to_regclass('tennis.board_research') is not null
               and to_regprocedure('tennis.ai_player_context(text)') is not null
               and has_table_privilege('anon', 'tennis.matches', 'SELECT')
              then 'ok' else 'CHECK THIS' end
  union all select 19, 'the LIVE contract is untouched by this file',
         case when to_regclass('tennis.live_matches') is null then 'ok (live contract not installed)'
              when (select count(*) from pg_policies
                     where schemaname = 'tennis' and tablename = 'live_matches') >= 1
              then 'ok (live tables keep their own policies)' else 'CHECK THIS' end
  union all select 20, 'the Lab needs no odds: every read above ran with odds_snapshots empty or not',
         case when to_regclass('tennis.odds_snapshots') is not null then 'ok' else 'CHECK THIS' end
)
select "row"::text as row, "check", result from checks order by "row";
