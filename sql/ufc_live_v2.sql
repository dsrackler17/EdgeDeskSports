-- ============================================================================
--  FILE:   sql/ufc_live_v2.sql
--  TYPE:   Additive migration — the canonical EdgeDesk UFC data layer
--  RUN:    Supabase → SQL Editor → paste → Run.  Safe to run repeatedly.
--  PAIRS:  supabase/functions/ufc_live_stats/index.ts  (the only writer)
--          app.html  (the only reader)
-- ============================================================================
--
-- THE THREE LAYERS
--
--   Layer 1 — EVENT / FIGHT STATE     what is happening now
--     ufc.live_events        (EXISTING, ufc_live writes)  current-state cache
--     ufc.live_fights        (EXISTING, ufc_live writes)  current-state cache
--     ufc.live_event_state   (new)  event metadata: venue, location, card
--     ufc.live_fight_state   (new)  bout metadata: referee, rounds, result, clock
--
--   Layer 2 — LIVE STATISTICS
--     ufc.live_fight_round_stats (new)  per round, per corner. Round 0 = total.
--     ufc.live_fight_snapshots   (new)  immutable, timestamped, deduplicated
--     ufc.fight_stats            (new)  canonical FINAL statistics once a bout
--                                       is over — UFCStats-compatible, and the
--                                       layer that survives the post-fight
--                                       corrections a live feed never issues
--
--   Layer 3 — RESEARCH + MARKET
--     ufc.fighters, ufc.fighter_fights, ufc.fighter_career_stats,
--     ufc.fighter_derived_metrics, ufc.fighter_style_metrics  (ALL EXISTING)
--     public.signals + public.signal_ticks                    (ALL EXISTING)
--     Market context is JOINED AT READ TIME in the app. No price, no fair line,
--     no edge and no tick is ever copied into the ufc schema. The odds capture
--     engine already owns opening price, current price, sharp fair, edge and
--     tick history; duplicating any of it here would create a second version of
--     a number that already has one.
--
-- SOURCE-AGNOSTIC BY CONSTRUCTION
--
--   Not one column below is named after a provider, and no provider's raw JSON
--   is stored. The Edge Function normalizes whatever the configured live
--   provider returns into the canonical contract these tables define, so the
--   provider can be replaced without touching this schema or the UI. `source`
--   records which provider a row came from, for provenance only.
-- ============================================================================
--
-- WHAT THIS DOES NOT DO — read this before editing.
--
--   It does not DROP anything.
--   It does not RENAME anything.
--   It does not TRUNCATE anything.
--   It does not ALTER a single existing column.
--   It does not touch `public.signals`, `public.signal_ticks`, or any table the
--   odds capture path writes.
--   It does not touch `ufc.fighters`, `ufc.fighter_fights`,
--   `ufc.fighter_career_stats`, `ufc.fighter_derived_metrics`,
--   `ufc.fighter_style_metrics`, or `ufc.meta`.
--   It does not touch `ufc.live_events` or `ufc.live_fights`.
--
-- Every statement below is CREATE ... IF NOT EXISTS or an idempotent policy
-- block. Running it twice is a no-op the second time.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY EXTENSION TABLES AND NOT NEW COLUMNS ON ufc.live_fights
--
--   The obvious move is `ALTER TABLE ufc.live_fights ADD COLUMN ...` for the
--   forty-odd live statistics. That move is a trap here, and the reason is
--   written down in EdgeDesk's own capture function.
--
--   `ufc.live_fights` is written by the existing `ufc_live` poller. That
--   poller's source is not in this repository, so nobody editing this file can
--   see how it writes. If it upserts a WHOLE row object — the ordinary way to
--   write a poller, and precisely the pattern `capture` had to split into
--   phase A / phase B to defend against — then every one of its runs would send
--   a tuple with no value for the new columns and NULL them out. The live stats
--   would flicker in and out on the poller's cadence, and the cause would be
--   invisible from the app.
--
--   A separate table keyed on the same identifier cannot be clobbered by a
--   writer that does not know it exists. `live_event_state` and
--   `live_fight_state` are 1:1 extensions of `live_events` and `live_fights` —
--   same primary key, same ID space, joined on read. This is vertical
--   partitioning, not a second architecture:
--
--     ufc.live_events   (existing, ufc_live writes)  ──┐
--     ufc.live_event_state (new, ufc_live_stats writes)┴─ joined on event_id
--
--     ufc.live_fights   (existing, ufc_live writes)  ──┐
--     ufc.live_fight_state (new, ufc_live_stats writes)┴─ joined on fight_id
--
--   PRECEDENCE, stated once so it is never ambiguous:
--     - `ufc.live_events` / `ufc.live_fights` remain the source of truth for
--       every field they already carry. ufc_live_stats NEVER writes them.
--     - The new tables are the source of truth for the deep fields only.
--     - The app prefers the existing tables for the shell and falls back to the
--       new tables when the old poller has written nothing, so the Fight Center
--       works whether one poller is deployed or both.
--
--   The new tables carry their own identity columns (names, status, times) for
--   exactly that fallback. That duplication is deliberate and is the price of
--   not being able to read the other writer's source.
-- ============================================================================

create schema if not exists ufc;

-- ============================================================================
--  1. EVENT STATE  — 1:1 extension of ufc.live_events
-- ============================================================================
create table if not exists ufc.live_event_state (
  event_id          text primary key,

  -- provenance. Every row can answer "where did this come from and when".
  source            text        not null default 'espn',
  source_event_id   text,
  source_url        text,

  name              text,
  short_name        text,
  status            text,                 -- pre | in | post | postponed | canceled
  status_detail     text,
  start_time        timestamptz,
  end_time          timestamptz,

  venue             text,
  location          text,

  -- card structure. jsonb because segment naming varies by promotion and a
  -- fixed enum would reject a card shape the source is entitled to invent.
  card_segments     jsonb,

  fights_total      integer,
  fights_completed  integer,
  fights_active     integer,
  current_fight_id  text,

  -- freshness. captured_at is first sighting and never moves; updated_at moves
  -- on every write. Same two-phase discipline as signals.first_seen_at /
  -- last_seen_at, for the same reason: an opening stamp you can overwrite is
  -- not an opening stamp.
  captured_at       timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists live_event_state_status_idx
  on ufc.live_event_state (status, start_time desc);
create index if not exists live_event_state_start_idx
  on ufc.live_event_state (start_time desc);

-- ============================================================================
--  2. FIGHT STATE  — 1:1 extension of ufc.live_fights
-- ============================================================================
create table if not exists ufc.live_fight_state (
  fight_id            text primary key,
  event_id            text not null,

  source              text not null default 'espn',
  source_event_id     text,
  source_fight_id     text,

  -- where this bout sits on the card
  card_segment        text,               -- main | prelim | early-prelim
  fight_order         integer,
  is_main             boolean,
  is_title            boolean,
  weight_class        text,
  scheduled_rounds    integer,
  referee             text,

  -- live clock
  status              text,               -- pre | in | post | canceled | postponed
  status_detail       text,
  round               integer,
  clock               text,               -- source's own display string, verbatim
  clock_seconds       integer,            -- parsed; NULL when unparseable
  elapsed_seconds     integer,            -- derived: completed rounds + this round

  -- FRESHNESS, kept as two separate facts because they answer different
  -- questions and conflating them is how a dead feed looks alive:
  --   source_timestamp  = when the PROVIDER says this state was true
  --   updated_at        = when EdgeDesk wrote the row
  -- A poller running happily against a frozen upstream has a moving updated_at
  -- and a stationary source_timestamp. Only the pair can tell you that.
  source_timestamp    timestamptz,
  source_freshness_seconds integer,       -- updated_at - source_timestamp, at write time

  -- corners. source_*_id is the feed's athlete id; *_fighter_id is EdgeDesk's
  -- ufc.fighters.fighter_id, resolved through ufc.fighter_source_map. Either
  -- may be NULL — an unresolved fighter is a legitimate state, not an error.
  red_fighter_id      text,
  red_name            text,
  red_source_id       text,
  blue_fighter_id     text,
  blue_name           text,
  blue_source_id      text,

  -- result, once there is one
  winner_fighter_id   text,
  winner_corner       text,               -- red | blue | draw | nc
  method              text,               -- KO/TKO | Submission | Decision | ...
  method_detail       text,
  decision_type       text,               -- Unanimous | Split | Majority
  end_round           integer,
  end_time            text,
  end_clock_seconds   integer,

  -- probability. ONLY ever a value the source published. EdgeDesk computes no
  -- UFC win probability and this column must never be filled with a derived
  -- number — the app badges it T3 espn.live_win_prob and that label has to
  -- stay true.
  red_win_prob        numeric,
  blue_win_prob       numeric,

  -- "are live statistics actually flowing for this bout". The difference
  -- between "the fight exists but the feed publishes no stats" and "the feed is
  -- broken" is the single most-asked diagnostic question, so it is stored
  -- rather than inferred by the reader.
  stats_available     boolean not null default false,
  last_stat_change_at timestamptz,

  captured_at         timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists live_fight_state_event_idx
  on ufc.live_fight_state (event_id, fight_order);
-- Partial index on the hot path: the poller and the UI both ask "which bouts
-- are live right now", and that is a handful of rows out of the whole table.
create index if not exists live_fight_state_active_idx
  on ufc.live_fight_state (event_id, updated_at desc)
  where status in ('in', 'live');
create index if not exists live_fight_state_updated_idx
  on ufc.live_fight_state (updated_at desc);

-- ============================================================================
--  3. ROUND-BY-ROUND STATISTICS
-- ============================================================================
--  One row per (fight, corner, round).
--
--  ROUND 0 IS RESERVED and means "fight total" — the cumulative line for the
--  bout so far. Rounds 1..N are that round only, where the source publishes a
--  per-round split. This keeps one table, one unique constraint and one dedup
--  rule instead of a totals table that would duplicate thirty columns.
--
--  is_cumulative says which of the two a row actually is, because some feeds
--  publish running totals under a round label. A number whose meaning you have
--  to guess is worse than no number, so the meaning is stored beside it.
--
--  Every stat is nullable ON PURPOSE. NULL means the source did not publish it.
--  It does not mean zero, and the UI renders it as unavailable. Defaulting
--  these to 0 would manufacture statistics, which is the one thing this system
--  is not allowed to do.
-- ============================================================================
create table if not exists ufc.live_fight_round_stats (
  id                        bigint generated always as identity primary key,
  fight_id                  text    not null,
  corner                    text    not null,     -- red | blue
  round                     integer not null,     -- 0 = fight total, 1..N = that round

  fighter_id                text,
  source_fighter_id         text,
  is_cumulative             boolean not null default false,
  round_status              text,               -- pending | in | complete

  -- striking
  sig_strikes_landed        integer,
  sig_strikes_attempted     integer,
  total_strikes_landed      integer,
  total_strikes_attempted   integer,
  head_strikes_landed       integer,
  head_strikes_attempted    integer,
  body_strikes_landed       integer,
  body_strikes_attempted    integer,
  leg_strikes_landed        integer,
  leg_strikes_attempted     integer,
  distance_strikes_landed   integer,
  distance_strikes_attempted integer,
  clinch_strikes_landed     integer,
  clinch_strikes_attempted  integer,
  ground_strikes_landed     integer,
  ground_strikes_attempted  integer,

  -- grappling
  takedowns_landed          integer,
  takedowns_attempted       integer,
  -- Written ONLY when the provider publishes a percentage of its own. When it
  -- is NULL the app divides landed by attempted, which is exact arithmetic on
  -- two stored numbers rather than a stat invented to fill a column. Storing a
  -- derivable value unconditionally is how a rounded provider percentage and a
  -- recomputed one drift apart and start disagreeing on the same screen.
  takedowns_pct             numeric,
  submission_attempts       integer,
  reversals                 integer,
  control_seconds           integer,
  knockdowns                integer,

  source                    text not null default 'unknown',
  source_timestamp          timestamptz,
  captured_at               timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint live_fight_round_stats_uniq unique (fight_id, corner, round),
  constraint live_fight_round_stats_corner_ck check (corner in ('red', 'blue')),
  constraint live_fight_round_stats_round_ck  check (round >= 0 and round <= 12)
);

create index if not exists live_fight_round_stats_fight_idx
  on ufc.live_fight_round_stats (fight_id, round, corner);

-- ============================================================================
--  4. APPEND-ONLY SNAPSHOTS  — "what did the fight look like at this point?"
-- ============================================================================
--  This table is never updated. It is only ever appended to, and it is the
--  reason the fight can be reconstructed at any earlier moment.
--
--  THE DEDUP RULE, AND WHY IT HASHES WHAT IT HASHES.
--
--  The poller runs every few seconds. A fight's statistics change far less
--  often than that. Writing a row per poll would produce tens of thousands of
--  identical rows per card and make the timeline unreadable.
--
--  So each snapshot carries a content_hash over THE STATISTICS AND THE ROUND
--  ONLY — deliberately NOT the clock. Including the clock would change the hash
--  on every single poll and defeat the whole mechanism. Excluding it means a
--  row is written exactly when a number actually moves, and `captured_at` is
--  the instant that new state was FIRST observed. That is the honest reading of
--  a snapshot timeline: these are the moments the fight changed.
--
--  The unique constraint does the deduplication in the database rather than in
--  the poller, so two overlapping runs — a retry, a manual invoke racing the
--  cron — cannot both write the same state.
--
--  Cumulative fight statistics are monotonic, so a repeated hash genuinely
--  means "nothing changed". `round` is in the key so a per-round reset cannot
--  collide with an identical-looking earlier round.
-- ============================================================================
create table if not exists ufc.live_fight_snapshots (
  id                        bigint generated always as identity primary key,
  fight_id                  text    not null,
  corner                    text    not null,
  round                     integer not null,

  -- when this state was first seen, and where the fight was when it was
  captured_at               timestamptz not null default now(),
  clock                     text,
  clock_seconds             integer,
  elapsed_seconds           integer,
  status                    text,

  fighter_id                text,
  source_fighter_id         text,

  -- cumulative fight totals at this instant
  sig_strikes_landed        integer,
  sig_strikes_attempted     integer,
  total_strikes_landed      integer,
  total_strikes_attempted   integer,
  head_strikes_landed       integer,
  head_strikes_attempted    integer,
  body_strikes_landed       integer,
  body_strikes_attempted    integer,
  leg_strikes_landed        integer,
  leg_strikes_attempted     integer,
  distance_strikes_landed   integer,
  distance_strikes_attempted integer,
  clinch_strikes_landed     integer,
  clinch_strikes_attempted  integer,
  ground_strikes_landed     integer,
  ground_strikes_attempted  integer,
  takedowns_landed          integer,
  takedowns_attempted       integer,
  takedowns_pct             numeric,
  submission_attempts       integer,
  reversals                 integer,
  control_seconds           integer,
  knockdowns                integer,

  source                    text not null default 'unknown',
  source_timestamp          timestamptz,
  content_hash              text not null,

  constraint live_fight_snapshots_uniq unique (fight_id, corner, round, content_hash),
  constraint live_fight_snapshots_corner_ck check (corner in ('red', 'blue'))
);

-- The timeline read: one fight, in order. This is the index the scrubber uses.
create index if not exists live_fight_snapshots_timeline_idx
  on ufc.live_fight_snapshots (fight_id, captured_at);
create index if not exists live_fight_snapshots_recent_idx
  on ufc.live_fight_snapshots (captured_at desc);

-- ============================================================================
--  4b. CANONICAL FINAL FIGHT STATISTICS
-- ============================================================================
--  The durable, corrected record of a COMPLETED bout. UFCStats-compatible.
--
--  WHY THIS IS NOT THE SAME TABLE AS THE LIVE ROUND STATS.
--
--  A live feed and a settled statistical record are different artifacts and
--  they disagree, routinely and legitimately:
--    - live counts are provisional and get revised after the fact;
--    - a live feed drops out mid-round and the round is permanently short;
--    - control time in particular is re-timed after review.
--  If the final numbers overwrote the live table, the snapshot timeline would
--  silently stop reconciling with the totals beside it — the fight would end
--  and the history of how it got there would become wrong. And if the live
--  numbers overwrote the final ones, a feed glitch would corrupt the research
--  substrate permanently.
--
--  So they are separate layers with separate lifetimes, and `source` says which
--  pipeline produced a row. Live stays as-observed forever. Final is allowed to
--  be corrected. The app reads final where it exists and live otherwise, and
--  says which it used.
--
--  fight_key is deliberately loose text: a live bout uses its fight_id, and a
--  historical bout uses whatever stable key the UFCStats backfill assigns. It
--  is not a foreign key to live_fight_state, because most rows here will be
--  fights that happened years before this table existed.
-- ============================================================================
create table if not exists ufc.fight_stats (
  id                        bigint generated always as identity primary key,
  fight_key                 text    not null,
  fighter_id                text,
  opponent_id               text,
  round                     integer not null,     -- 0 = fight total, 1..N = that round

  event_id                  text,
  event_name                text,
  event_date                date,
  venue                     text,
  location                  text,
  referee                   text,
  weight_class              text,
  title_fight               boolean,
  scheduled_rounds          integer,

  -- result, as settled
  result                    text,                 -- win | loss | draw | nc
  method                    text,
  method_detail             text,
  decision_type             text,
  end_round                 integer,
  end_time                  text,

  -- the same stat contract as the live layer, so one renderer draws both
  sig_strikes_landed        integer,
  sig_strikes_attempted     integer,
  total_strikes_landed      integer,
  total_strikes_attempted   integer,
  head_strikes_landed       integer,
  head_strikes_attempted    integer,
  body_strikes_landed       integer,
  body_strikes_attempted    integer,
  leg_strikes_landed        integer,
  leg_strikes_attempted     integer,
  distance_strikes_landed   integer,
  distance_strikes_attempted integer,
  clinch_strikes_landed     integer,
  clinch_strikes_attempted  integer,
  ground_strikes_landed     integer,
  ground_strikes_attempted  integer,
  takedowns_landed          integer,
  takedowns_attempted       integer,
  takedowns_pct             numeric,
  submission_attempts       integer,
  reversals                 integer,
  control_seconds           integer,
  knockdowns                integer,

  source                    text not null default 'ufcstats',
  source_fight_id           text,
  captured_at               timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint fight_stats_uniq unique (fight_key, fighter_id, round),
  constraint fight_stats_round_ck check (round >= 0 and round <= 12)
);

create index if not exists fight_stats_fighter_idx
  on ufc.fight_stats (fighter_id, event_date desc);
create index if not exists fight_stats_event_idx
  on ufc.fight_stats (event_id);
-- Recent form reads only the fight totals, so give that its own partial index
-- rather than making it scan every round row of every fight ever ingested.
create index if not exists fight_stats_totals_idx
  on ufc.fight_stats (fighter_id, event_date desc) where round = 0;

-- ============================================================================
--  5. FIGHTER ID MAPPING  — feed athlete id  ->  ufc.fighters.fighter_id
-- ============================================================================
--  There was no explicit mapping table before this. The live feed's athlete ids
--  and the UFCStats-derived `ufc.fighters.fighter_id` are different ID spaces,
--  and the app already has a visible failure mode for the gap: a fighter it
--  cannot resolve renders `ufcProfileNotInDB`.
--
--  Storing the mapping does three things a name match at request time cannot:
--    - it is CACHED, so the poller does not re-resolve every fighter every few
--      seconds against the whole fighters table;
--    - it is TRACEABLE — match_method records HOW a link was made, so a wrong
--      link can be found and corrected rather than silently persisting;
--    - an unresolved fighter is RECORDED as unresolved (fighter_id NULL) rather
--      than retried forever.
-- ============================================================================
create table if not exists ufc.fighter_source_map (
  source            text not null default 'unknown',
  source_fighter_id text not null,

  fighter_id        text,                 -- NULL = looked, did not find. A real answer.
  source_name       text,
  normalized_name   text,
  match_method      text,                 -- exact | normalized | manual | unresolved
  confidence        numeric,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  primary key (source, source_fighter_id)
);

create index if not exists fighter_source_map_fighter_idx
  on ufc.fighter_source_map (fighter_id);
create index if not exists fighter_source_map_norm_idx
  on ufc.fighter_source_map (normalized_name);

-- ============================================================================
--  6. CAPTURE TELEMETRY  — one row per run of ufc_live_stats
-- ============================================================================
--  The point of this table is to make five questions answerable apart, because
--  on a blank screen they look identical and have five different fixes:
--
--    "there is no UFC data"                     -> events_discovered = 0
--    "the UFC source is broken"                 -> api_failures > 0, http_status
--    "there is an event but no active fight"    -> events_active > 0, fights_active = 0
--    "the fight exists but stats are missing"   -> fights_active > 0, stat_rows = 0
--    "the UI is failing to consume valid data"  -> everything above is healthy
-- ============================================================================
create table if not exists ufc.live_capture_runs (
  id                        bigint generated always as identity primary key,
  build                     text,
  mode                      text,           -- idle | active | diag
  ok                        boolean not null default false,
  status                    text,           -- ok | partial | failed | idle | diagnostic | unconfigured

  -- WHICH PROVIDER, AND WHETHER ITS ADAPTER HAS BEEN VERIFIED AGAINST A REAL
  -- RESPONSE. An adapter written from documentation rather than from an
  -- observed payload is a hypothesis, and a hypothesis that silently returns
  -- nothing looks exactly like a quiet night. provider_verified is how the
  -- diagnostics tell those two apart.
  provider                  text,
  provider_verified         boolean,

  started_at                timestamptz not null default now(),
  finished_at               timestamptz,
  duration_ms               integer,

  events_discovered         integer not null default 0,
  events_active             integer not null default 0,
  fights_discovered         integer not null default 0,
  fights_active             integer not null default 0,
  fights_completed          integer not null default 0,

  fighters_resolved         integer not null default 0,
  fighters_unresolved       integer not null default 0,

  round_rows_written        integer not null default 0,
  state_rows_written        integer not null default 0,
  snapshots_written         integer not null default 0,
  snapshots_skipped_dup     integer not null default 0,

  api_requests              integer not null default 0,
  api_failures              integer not null default 0,
  api_timeouts              integer not null default 0,
  rate_limited              integer not null default 0,
  http_status_counts        jsonb,
  malformed_events          integer not null default 0,
  malformed_fights          integer not null default 0,
  missing_stat_fields       integer not null default 0,
  -- Stat keys the feed published that the normalizer has no mapping for. This
  -- is how a source renaming a field gets noticed instead of silently becoming
  -- a blank column: the key shows up here and the alias table gets extended.
  unmapped_stat_keys        jsonb,

  db_write_failures         integer not null default 0,
  write_errors              jsonb,

  active_event_id           text,
  active_fight_id           text,
  source_freshness_seconds  integer,
  error                     text,
  detail                    jsonb
);

create index if not exists live_capture_runs_started_idx
  on ufc.live_capture_runs (started_at desc);
-- "when did this last actually work" — the query the diagnostics panel runs.
create index if not exists live_capture_runs_ok_idx
  on ufc.live_capture_runs (started_at desc) where ok;

-- ============================================================================
--  7. DIAGNOSTIC VIEW
-- ============================================================================
--  One read that answers "is the UFC live pipeline healthy". CREATE OR REPLACE
--  is safe here: this view is created by this file and by nothing else, so
--  replacing it cannot overwrite another component's definition.
-- ============================================================================
create or replace view ufc.live_pipeline_health as
select
  r.started_at                                        as last_run_at,
  r.status                                            as last_run_status,
  r.ok                                                as last_run_ok,
  r.duration_ms,
  r.mode,
  r.provider,
  r.provider_verified,
  r.events_discovered,
  r.events_active,
  r.fights_discovered,
  r.fights_active,
  r.snapshots_written,
  r.snapshots_skipped_dup,
  r.api_requests,
  r.api_failures,
  r.rate_limited,
  r.http_status_counts,
  r.unmapped_stat_keys,
  r.db_write_failures,
  r.active_event_id,
  r.active_fight_id,
  extract(epoch from (now() - r.started_at))::int     as seconds_since_last_run,
  (select max(started_at) from ufc.live_capture_runs where ok) as last_ok_run_at,
  (select count(*) from ufc.live_fight_state
     where status in ('in','live'))                   as fights_live_now,
  (select count(*) from ufc.live_fight_state
     where status in ('in','live') and stats_available) as fights_live_with_stats,
  (select count(*) from ufc.live_fight_snapshots)     as snapshots_total
from ufc.live_capture_runs r
order by r.started_at desc
limit 1;

-- ============================================================================
--  8. ROW LEVEL SECURITY
-- ============================================================================
--  Reads are the signed-in app. Writes are the Edge Function, which uses the
--  service role and bypasses RLS entirely — so there is deliberately no INSERT
--  or UPDATE policy here. Nothing but the poller can write these tables.
--
--  Grants go to `authenticated` only, not `anon`. If the existing ufc.* tables
--  in this project also grant anon and you want the Fight Center visible logged
--  out, add anon to the grants below — it is a deliberate choice, not an
--  oversight, and the conservative default is the one that cannot leak.
-- ============================================================================
grant usage on schema ufc to authenticated;

do $$
declare t text;
begin
  foreach t in array array[
    'live_event_state',
    'live_fight_state',
    'live_fight_round_stats',
    'live_fight_snapshots',
    'fight_stats',
    'fighter_source_map',
    'live_capture_runs'
  ]
  loop
    execute format('alter table ufc.%I enable row level security', t);
    execute format('grant select on ufc.%I to authenticated', t);

    -- idempotent: only create the policy when it is not already there, so a
    -- second run neither errors nor silently replaces a policy you edited.
    if not exists (
      select 1 from pg_policies
      where schemaname = 'ufc' and tablename = t
        and policyname = 'ufc_live_read_authenticated'
    ) then
      execute format(
        'create policy ufc_live_read_authenticated on ufc.%I for select to authenticated using (true)', t);
    end if;
  end loop;
end $$;

grant select on ufc.live_pipeline_health to authenticated;

-- ============================================================================
--  9. VERIFY
-- ============================================================================
--  Run this after the migration. Seven tables, one view. If a row is missing,
--  the statement that creates it failed and the error is above in the output.
-- ============================================================================
select table_name, 'table' as kind
from information_schema.tables
where table_schema = 'ufc'
  and table_name in ('live_event_state','live_fight_state','live_fight_round_stats',
                     'live_fight_snapshots','fight_stats','fighter_source_map',
                     'live_capture_runs')
union all
select table_name, 'view'
from information_schema.views
where table_schema = 'ufc' and table_name = 'live_pipeline_health'
order by kind, table_name;
