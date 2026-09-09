-- ===========================================================================
-- EdgeDesk UFC — the Live Fight Center data contract.
--
-- WHY THIS FILE EXISTS. The Fight Center read a live layer that no file in
-- this repository ever created: ufc.live_events / ufc.live_fights were written
-- by an Edge Function called ufc_live, and ufc.live_event_state /
-- ufc.live_fight_state / ufc.live_fight_round_stats / ufc.live_fight_snapshots
-- by another called ufc_live_stats. Neither function, nor the SQL that made
-- their tables (sql/ufc_live.sql, sql/ufc_live_v2.sql), was ever committed.
-- When the poller stopped — twenty days before this was written — nothing in
-- a checkout could say why, and the screen said "Event found but no fights
-- loaded yet" to a customer.
--
-- This is the replacement contract, written to be fed from GitHub Actions
-- (tools/ufc/*.js, over PostgREST with the service role) and read by the
-- browser through the same anon/RLS door every other research table uses.
-- No Edge Function is in the path.
--
--   ufc.events            one row per card: state, venue, start, current bout
--   ufc.bouts             one row per fight: corners, order, status, result,
--                         and first_bell_at — the boundary a closing line
--                         must sit on the right side of
--   ufc.fight_live_state  the latest cumulative statistics, one row per corner
--   ufc.fight_round_stats one row per round per corner (provider splits where
--                         the source publishes them, otherwise the difference
--                         between cumulative snapshots at round boundaries,
--                         labelled as such)
--   ufc.fight_snapshots   immutable timeline, deduplicated by content
--   ufc.fighter_aliases   provider ids and name variants -> ufc.fighters ids
--   ufc.fighter_baselines precomputed historical tendencies, WITH sample sizes
--   ufc.bout_markets      the link from a bout to its odds-feed fixture, made
--                         only when BOTH fighters resolved. A "Draw" outcome is
--                         a market row, never a fighter, and never a corner.
--   ufc.market_captures   every price observation tagged PRE or LIVE against
--                         the bout's own first bell
--   ufc.market_rejections what the linker refused, and why, for operators
--   ufc.pipeline_runs     heartbeat and diagnostics for every job
--   ufc.live_locks        one live poller per event, enforced in the database
--
-- Idempotent, additive, and it ends in a report — the convention every file in
-- this folder follows. Run it in the SQL editor. Every report row should say ok.
-- Nothing already in the ufc schema is dropped, renamed or rewritten: the old
-- live_* tables are left exactly as they are and simply stop being read.
--
-- Tested against a real PostgreSQL by tools/ufc/ufc_sql.test.js
-- (`npm run ufc:sql`), which applies this file unmodified, applies it again,
-- attacks it as anon and as authenticated, and races the lock.
-- ===========================================================================

create schema if not exists ufc;
grant usage on schema ufc to anon, authenticated, service_role;

-- The dataset pipeline's own ledger already lives here in production
-- (key/value). Creating it here is a no-op there and gives a fresh database
-- the same row shape the shell's pipeline ledger reads. In production the
-- table predates this file and was owned without a grant to service_role
-- (the first sync logged "permission denied for table meta"), so the grant
-- is made here, explicitly, and the report checks it.
create table if not exists ufc.meta (
  key   text primary key,
  value text
);
grant select, insert, update on ufc.meta to service_role;
grant select on ufc.meta to anon, authenticated;

-- ---------------------------------------------------------------------------
-- updated_at, kept by the database rather than by every writer remembering to
-- ---------------------------------------------------------------------------
create or replace function ufc.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- EVENTS
-- ---------------------------------------------------------------------------
create table if not exists ufc.events (
  event_id            text primary key,                 -- 'espn:<provider id>'
  provider            text not null default 'espn',
  provider_event_id   text not null,
  name                text,
  short_name          text,
  promotion           text not null default 'UFC',
  venue               text,
  city                text,
  state               text,
  country             text,
  timezone            text,
  scheduled_at        timestamptz,
  event_state         text not null default 'scheduled',
  current_bout_id     text,
  first_bell_at       timestamptz,
  completed_at        timestamptz,
  bouts_total         integer,
  bouts_completed     integer,
  bouts_live          integer,
  source              text,
  source_url          text,
  source_updated_at   timestamptz,
  ingested_at         timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint ufc_events_state_shape check
    (event_state in ('scheduled','live','final','cancelled','postponed','stale')),
  constraint ufc_events_provider_key unique (provider, provider_event_id)
);
create index if not exists ufc_events_scheduled_idx on ufc.events (scheduled_at desc);
create index if not exists ufc_events_state_idx on ufc.events (event_state, scheduled_at desc);
drop trigger if exists ufc_events_touch on ufc.events;
create trigger ufc_events_touch before update on ufc.events
  for each row execute function ufc.touch_updated_at();

-- ---------------------------------------------------------------------------
-- BOUTS
-- ---------------------------------------------------------------------------
create table if not exists ufc.bouts (
  bout_id             text primary key,                 -- 'espn:<competition id>'
  event_id            text not null references ufc.events(event_id) on delete cascade,
  provider            text not null default 'espn',
  provider_bout_id    text not null,
  bout_order          integer,                          -- 1 = first fight of the night
  card_segment        text,                             -- Early Prelims / Prelims / Main Card
  is_main             boolean not null default false,
  is_title            boolean not null default false,
  weight_class        text,
  scheduled_rounds    integer,
  red_provider_id     text,
  blue_provider_id    text,
  red_name            text,
  blue_name           text,
  red_fighter_id      text,                             -- ufc.fighters.fighter_id, when resolved
  blue_fighter_id     text,
  red_record          text,
  blue_record         text,
  red_rank            text,
  blue_rank           text,
  corner_source       text not null default 'provider_order',
  status              text not null default 'scheduled',
  status_detail       text,
  round               integer,
  clock               text,
  clock_seconds       integer,
  elapsed_seconds     integer,
  winner_corner       text,
  winner_fighter_id   text,
  method              text,
  method_detail       text,
  result_detail       text,
  end_round           integer,
  end_time            text,
  referee             text,
  -- THE BOUNDARY. first_bell_at is the LAST poll that still saw this bout as
  -- not started, so every capture at or before it is provably pre-fight. When
  -- the poller only ever saw the bout live (a restart mid-fight) it stays null
  -- and close_bound_source says which weaker bound, if any, applies.
  first_bell_at       timestamptz,
  first_live_seen_at  timestamptz,
  close_bound_source  text,
  completed_at        timestamptz,
  source_updated_at   timestamptz,
  ingested_at         timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint ufc_bouts_status_shape check
    (status in ('scheduled','live','final','cancelled','postponed','no_contest','unknown')),
  constraint ufc_bouts_winner_shape check
    (winner_corner is null or winner_corner in ('red','blue','draw','nc')),
  constraint ufc_bouts_close_bound_shape check
    (close_bound_source is null or close_bound_source in ('observed_bell','card_start')),
  constraint ufc_bouts_provider_key unique (provider, provider_bout_id)
);
create index if not exists ufc_bouts_event_idx on ufc.bouts (event_id, bout_order);
create index if not exists ufc_bouts_red_idx on ufc.bouts (red_fighter_id);
create index if not exists ufc_bouts_blue_idx on ufc.bouts (blue_fighter_id);
create index if not exists ufc_bouts_status_idx on ufc.bouts (status);
drop trigger if exists ufc_bouts_touch on ufc.bouts;
create trigger ufc_bouts_touch before update on ufc.bouts
  for each row execute function ufc.touch_updated_at();

-- ---------------------------------------------------------------------------
-- LIVE STATE — the latest cumulative numbers, one row per corner. Only the
-- fields the source actually publishes are ever non-null; a dash in the UI is
-- a null here, never a zero written for convenience.
-- ---------------------------------------------------------------------------
create table if not exists ufc.fight_live_state (
  bout_id                   text not null references ufc.bouts(bout_id) on delete cascade,
  event_id                  text not null,
  corner                    text not null,
  fighter_id                text,
  provider_athlete_id       text,
  fighter_name              text,
  status                    text,
  round                     integer,
  clock                     text,
  clock_seconds             integer,
  elapsed_seconds           integer,
  knockdowns                integer,
  sig_strikes_landed        integer,
  sig_strikes_attempted     integer,
  total_strikes_landed      integer,
  total_strikes_attempted   integer,
  takedowns_landed          integer,
  takedowns_attempted       integer,
  submission_attempts       integer,
  reversals                 integer,
  control_seconds           integer,
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
  stats_available           boolean not null default false,
  source                    text,
  source_updated_at         timestamptz,
  source_latency_ms         integer,
  content_hash              text,
  updated_at                timestamptz not null default now(),
  primary key (bout_id, corner),
  constraint ufc_live_state_corner_shape check (corner in ('red','blue'))
);
create index if not exists ufc_live_state_event_idx on ufc.fight_live_state (event_id);
drop trigger if exists ufc_fight_live_state_touch on ufc.fight_live_state;
create trigger ufc_fight_live_state_touch before update on ufc.fight_live_state
  for each row execute function ufc.touch_updated_at();

-- ---------------------------------------------------------------------------
-- ROUND STATS — that round only. stat_source says whether the provider
-- published the split or whether it is the difference between two cumulative
-- snapshots taken at the round's boundaries; the UI labels the second kind.
-- ---------------------------------------------------------------------------
create table if not exists ufc.fight_round_stats (
  bout_id                   text not null references ufc.bouts(bout_id) on delete cascade,
  event_id                  text not null,
  round                     integer not null,
  corner                    text not null,
  fighter_id                text,
  round_status              text not null default 'in_progress',
  stat_source               text not null default 'snapshot_delta',
  round_seconds             integer,
  knockdowns                integer,
  sig_strikes_landed        integer,
  sig_strikes_attempted     integer,
  total_strikes_landed      integer,
  total_strikes_attempted   integer,
  takedowns_landed          integer,
  takedowns_attempted       integer,
  submission_attempts       integer,
  reversals                 integer,
  control_seconds           integer,
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
  updated_at                timestamptz not null default now(),
  primary key (bout_id, round, corner),
  constraint ufc_round_stats_round_shape check (round >= 1),
  constraint ufc_round_stats_corner_shape check (corner in ('red','blue')),
  constraint ufc_round_stats_status_shape check (round_status in ('in_progress','complete')),
  constraint ufc_round_stats_source_shape check (stat_source in ('provider','snapshot_delta'))
);
create index if not exists ufc_round_stats_event_idx on ufc.fight_round_stats (event_id);
drop trigger if exists ufc_fight_round_stats_touch on ufc.fight_round_stats;
create trigger ufc_fight_round_stats_touch before update on ufc.fight_round_stats
  for each row execute function ufc.touch_updated_at();

-- ---------------------------------------------------------------------------
-- SNAPSHOTS — immutable, deduplicated by content. The same state observed
-- twice (a restarted poller, a frozen upstream) is one row, which is what
-- makes a restart safe and a "numbers have not moved" night cheap.
-- ---------------------------------------------------------------------------
create table if not exists ufc.fight_snapshots (
  id                        bigserial primary key,
  bout_id                   text not null references ufc.bouts(bout_id) on delete cascade,
  corner                    text not null,
  captured_at               timestamptz not null default now(),
  status                    text,
  round                     integer,
  clock                     text,
  clock_seconds             integer,
  elapsed_seconds           integer,
  knockdowns                integer,
  sig_strikes_landed        integer,
  sig_strikes_attempted     integer,
  total_strikes_landed      integer,
  total_strikes_attempted   integer,
  takedowns_landed          integer,
  takedowns_attempted       integer,
  submission_attempts       integer,
  reversals                 integer,
  control_seconds           integer,
  head_strikes_landed       integer,
  body_strikes_landed       integer,
  leg_strikes_landed        integer,
  distance_strikes_landed   integer,
  clinch_strikes_landed     integer,
  ground_strikes_landed     integer,
  content_hash              text not null,
  constraint ufc_snapshots_corner_shape check (corner in ('red','blue')),
  constraint ufc_snapshots_dedup unique (bout_id, corner, content_hash)
);
create index if not exists ufc_snapshots_bout_idx on ufc.fight_snapshots (bout_id, captured_at);

-- ---------------------------------------------------------------------------
-- FIGHTER IDENTITY — provider ids and name variants resolved to the dataset's
-- fighter_id. An alias is written only when the resolution was unambiguous;
-- a surname that matches two people is not a match and is never stored.
-- ---------------------------------------------------------------------------
create table if not exists ufc.fighter_aliases (
  alias_key     text primary key,        -- 'espn:<athlete id>' | 'name:<normalized name>'
  fighter_id    text not null,
  display_name  text,
  source        text not null default 'sync',
  confidence    text not null default 'exact',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint ufc_aliases_confidence_shape check
    (confidence in ('exact','provider_id','name_order','surname','curated','manual'))
);
create index if not exists ufc_aliases_fighter_idx on ufc.fighter_aliases (fighter_id);
drop trigger if exists ufc_fighter_aliases_touch on ufc.fighter_aliases;
create trigger ufc_fighter_aliases_touch before update on ufc.fighter_aliases
  for each row execute function ufc.touch_updated_at();

-- ---------------------------------------------------------------------------
-- FIGHTER BASELINES — precomputed by tools/ufc/build_baselines.js from the
-- fight history and career microstats already on file, so the browser
-- compares two rows instead of recomputing thousands of fights. Every rate
-- carries the sample it was computed over; a metric with no sample is null.
-- The obs_* columns are EdgeDesk's own observed baselines, accumulated from
-- fights this pipeline has watched — they start empty and say so.
-- ---------------------------------------------------------------------------
create table if not exists ufc.fighter_baselines (
  fighter_id                 text primary key,
  full_name                  text,
  built_at                   timestamptz not null default now(),
  builder_version            text,
  -- samples
  fights_on_file             integer not null default 0,
  dated_fights               integer not null default 0,
  career_stats_available     boolean not null default false,
  -- UFCStats career averages, copied so one row answers the whole panel
  slpm                       numeric,
  sapm                       numeric,
  striking_accuracy          numeric,
  striking_defense           numeric,
  takedown_avg               numeric,
  takedown_accuracy          numeric,
  takedown_defense           numeric,
  submission_avg             numeric,
  knockdown_avg              numeric,
  control_time_avg           numeric,
  -- results, from fight history
  wins                       integer,
  losses                     integer,
  draws                      integer,
  no_contests                integer,
  win_ko                     integer,
  win_sub                    integer,
  win_dec                    integer,
  loss_ko                    integer,
  loss_sub                   integer,
  loss_dec                   integer,
  finish_rate                numeric,
  ko_rate                    numeric,
  sub_rate                   numeric,
  decision_rate              numeric,
  finished_loss_rate         numeric,
  distance_rate              numeric,
  -- duration and depth
  avg_fight_seconds          numeric,
  total_fight_seconds        integer,
  timed_fights               integer,
  five_round_scheduled       integer,
  fights_past_r3             integer,
  r4_r5_seconds              integer,
  finishes_after_r3          integer,
  title_fights               integer,
  round_finish_dist          jsonb,
  -- activity
  last_fight_at              date,
  days_since_last_fight      integer,
  fights_last_365            integer,
  fights_last_730            integer,
  current_streak             integer,
  -- recent form versus career
  last3_wins                 integer,
  last3_finishes             integer,
  last3_avg_fight_seconds    numeric,
  last5_wins                 integer,
  last5_finishes             integer,
  last5_avg_fight_seconds    numeric,
  -- opponent quality
  opp_avg_win_pct            numeric,
  opp_sample                 integer,
  opp_adj_win_pct            numeric,
  -- EdgeDesk-observed live baselines (from this pipeline's own fights)
  obs_fights                 integer not null default 0,
  obs_sig_attempts_per_min   numeric,
  obs_sig_landed_per_min     numeric,
  obs_absorbed_per_min       numeric,
  obs_td_attempts_per_15     numeric,
  obs_head_share             numeric,
  obs_body_share             numeric,
  obs_leg_share              numeric,
  obs_distance_share         numeric,
  obs_clinch_share           numeric,
  obs_ground_share           numeric,
  obs_round_pace             jsonb,
  -- style classification, from documented rules in lib/ufc_research.js
  style_labels               text[],
  style_rules_version        text,
  notes                      jsonb not null default '[]'::jsonb,
  updated_at                 timestamptz not null default now()
);
create index if not exists ufc_baselines_built_idx on ufc.fighter_baselines (built_at desc);
drop trigger if exists ufc_fighter_baselines_touch on ufc.fighter_baselines;
create trigger ufc_fighter_baselines_touch before update on ufc.fighter_baselines
  for each row execute function ufc.touch_updated_at();

-- ---------------------------------------------------------------------------
-- MARKET LINKS — a bout is linked to an odds-feed fixture only when both of
-- the fixture's participants resolved to the bout's two corners. The link
-- carries the sig_keys for each corner and, separately, for a draw outcome
-- where a book prices one; there is no path by which a draw becomes a corner.
-- ---------------------------------------------------------------------------
create table if not exists ufc.bout_markets (
  bout_id          text primary key references ufc.bouts(bout_id) on delete cascade,
  event_id         text not null,
  signal_event_id  text not null,
  sport_key        text not null default 'mma_mixed_martial_arts',
  home_team        text,
  away_team        text,
  red_selection    text,
  blue_selection   text,
  red_sig_key      text,
  blue_sig_key     text,
  draw_sig_key     text,
  other_sig_keys   text[],
  commence_time    timestamptz,
  link_method      text not null,
  linked_at        timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint ufc_bout_markets_fixture_key unique (signal_event_id),
  constraint ufc_bout_markets_method_shape check
    (link_method in ('both_names_exact','both_names_alias','manual'))
);
create index if not exists ufc_bout_markets_event_idx on ufc.bout_markets (event_id);
drop trigger if exists ufc_bout_markets_touch on ufc.bout_markets;
create trigger ufc_bout_markets_touch before update on ufc.bout_markets
  for each row execute function ufc.touch_updated_at();

-- ---------------------------------------------------------------------------
-- MARKET CAPTURES — every observed price, tagged PRE or LIVE against the
-- bout's own first bell at the moment it was written. A LIVE row can never be
-- re-tagged PRE: the tag is part of the row, not a view over it.
-- ---------------------------------------------------------------------------
create table if not exists ufc.market_captures (
  id               bigserial primary key,
  bout_id          text not null references ufc.bouts(bout_id) on delete cascade,
  event_id         text not null,
  sig_key          text not null,
  corner           text not null,
  book             text,
  capture_at       timestamptz not null,
  market_state     text not null,
  round            integer,
  clock            text,
  best_dec         numeric,
  sharp_fair       numeric,
  consensus_fair   numeric,
  n_books          integer,
  has_sharp        boolean,
  source           text not null default 'signals',
  constraint ufc_market_captures_corner_shape check (corner in ('red','blue','draw')),
  constraint ufc_market_captures_state_shape check (market_state in ('PRE','LIVE')),
  constraint ufc_market_captures_dedup unique (sig_key, capture_at)
);
create index if not exists ufc_market_captures_bout_idx on ufc.market_captures (bout_id, capture_at);
create index if not exists ufc_market_captures_event_idx on ufc.market_captures (event_id, market_state);

-- ---------------------------------------------------------------------------
-- MARKET REJECTIONS — what the linker refused. This is the operator's window
-- onto "Jean Silva vs Draw": the row is here with its reason instead of on a
-- customer's screen as a bout.
-- ---------------------------------------------------------------------------
create table if not exists ufc.market_rejections (
  id               bigserial primary key,
  signal_event_id  text not null default '',
  sig_key          text not null default '',
  sport_key        text,
  home_team        text,
  away_team        text,
  selection        text,
  market           text,
  reason           text not null,
  detail           text,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  seen_count       integer not null default 1,
  constraint ufc_market_rejections_key unique (signal_event_id, sig_key, reason)
);
create index if not exists ufc_market_rejections_seen_idx on ufc.market_rejections (last_seen_at desc);

-- ---------------------------------------------------------------------------
-- PIPELINE RUNS — one row per job run, heartbeat while it lives. The status
-- view below reads the latest per job; the UI's health level is computed from
-- these stamps against stated thresholds, never from a status word alone.
-- ---------------------------------------------------------------------------
create table if not exists ufc.pipeline_runs (
  run_id                text primary key,
  job                   text not null,
  event_id              text,
  status                text not null default 'running',
  started_at            timestamptz not null default now(),
  heartbeat_at          timestamptz not null default now(),
  finished_at           timestamptz,
  last_success_at       timestamptz,
  last_source_at        timestamptz,
  source_latency_ms     integer,
  consecutive_failures  integer not null default 0,
  polls                 integer not null default 0,
  writes                integer not null default 0,
  github_run_id         text,
  github_run_url        text,
  workflow              text,
  message               text,
  details               jsonb not null default '{}'::jsonb,
  updated_at            timestamptz not null default now(),
  constraint ufc_pipeline_runs_status_shape check
    (status in ('running','ok','warn','error','cancelled','timeout','handed_off'))
);
create index if not exists ufc_pipeline_runs_job_idx on ufc.pipeline_runs (job, started_at desc);
drop trigger if exists ufc_pipeline_runs_touch on ufc.pipeline_runs;
create trigger ufc_pipeline_runs_touch before update on ufc.pipeline_runs
  for each row execute function ufc.touch_updated_at();

create or replace view ufc.pipeline_status
with (security_invoker = true) as
  select distinct on (job)
         job, run_id, event_id, status, started_at, heartbeat_at, finished_at,
         last_success_at, last_source_at, source_latency_ms, consecutive_failures,
         polls, writes, github_run_id, github_run_url, workflow, message, details,
         extract(epoch from (now() - heartbeat_at))::integer as seconds_since_heartbeat,
         extract(epoch from (now() - coalesce(last_success_at, started_at)))::integer as seconds_since_success,
         extract(epoch from (now() - last_source_at))::integer as seconds_since_source
    from ufc.pipeline_runs
   order by job, started_at desc;

-- ---------------------------------------------------------------------------
-- LIVE LOCKS — one poller per event. Acquisition is a single statement, so
-- two workflow runs that start in the same second cannot both hold it; a
-- holder that stops heartbeating loses it after the TTL, so a cancelled job
-- cannot fence the next one out.
-- ---------------------------------------------------------------------------
create table if not exists ufc.live_locks (
  event_id      text primary key,
  owner         text not null,
  acquired_at   timestamptz not null default now(),
  heartbeat_at  timestamptz not null default now(),
  expires_at    timestamptz not null
);

create or replace function ufc.acquire_live_lock(p_event_id text, p_owner text, p_ttl_seconds integer default 120)
returns jsonb
language plpgsql
security definer
set search_path = ufc, pg_temp
as $$
declare
  r ufc.live_locks%rowtype;
  ttl integer := greatest(coalesce(p_ttl_seconds, 120), 10);
begin
  if p_event_id is null or p_owner is null or length(p_owner) = 0 then
    return jsonb_build_object('acquired', false, 'reason', 'missing_argument');
  end if;
  insert into ufc.live_locks (event_id, owner, acquired_at, heartbeat_at, expires_at)
       values (p_event_id, p_owner, now(), now(), now() + make_interval(secs => ttl))
  on conflict (event_id) do update
     set owner        = excluded.owner,
         acquired_at  = case when ufc.live_locks.owner = excluded.owner then ufc.live_locks.acquired_at else now() end,
         heartbeat_at = now(),
         expires_at   = now() + make_interval(secs => ttl)
   where ufc.live_locks.owner = excluded.owner
      or ufc.live_locks.expires_at < now()
  returning * into r;
  if r.event_id is null then
    select * into r from ufc.live_locks where event_id = p_event_id;
    return jsonb_build_object('acquired', false, 'reason', 'held',
                              'owner', r.owner, 'expires_at', r.expires_at, 'heartbeat_at', r.heartbeat_at);
  end if;
  return jsonb_build_object('acquired', true, 'owner', r.owner, 'expires_at', r.expires_at,
                            'acquired_at', r.acquired_at);
end $$;

create or replace function ufc.release_live_lock(p_event_id text, p_owner text)
returns boolean
language plpgsql
security definer
set search_path = ufc, pg_temp
as $$
declare n integer;
begin
  delete from ufc.live_locks where event_id = p_event_id and owner = p_owner;
  get diagnostics n = row_count;
  return n > 0;
end $$;

revoke all on function ufc.acquire_live_lock(text, text, integer) from public, anon, authenticated;
revoke all on function ufc.release_live_lock(text, text) from public, anon, authenticated;
grant execute on function ufc.acquire_live_lock(text, text, integer) to service_role;
grant execute on function ufc.release_live_lock(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- ROW LEVEL SECURITY. Public reads on the research tables; no client role may
-- write anything; the lock table is unreachable from a browser altogether.
-- The service role bypasses RLS, which is the only door the jobs use.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['events','bouts','fight_live_state','fight_round_stats','fight_snapshots',
                           'fighter_aliases','fighter_baselines','bout_markets','market_captures',
                           'market_rejections','pipeline_runs'] loop
    execute format('alter table ufc.%I enable row level security', t);
    execute format('revoke insert, update, delete, truncate, references, trigger on ufc.%I from anon, authenticated', t);
    execute format('grant select on ufc.%I to anon, authenticated', t);
    execute format('grant all on ufc.%I to service_role', t);
    execute format('drop policy if exists %I on ufc.%I', 'ufc_' || t || '_public_read', t);
    execute format('create policy %I on ufc.%I for select to anon, authenticated using (true)',
                   'ufc_' || t || '_public_read', t);
  end loop;
end $$;

alter table ufc.live_locks enable row level security;
revoke all on ufc.live_locks from anon, authenticated;
grant all on ufc.live_locks to service_role;

grant select on ufc.pipeline_status to anon, authenticated, service_role;
grant usage, select on all sequences in schema ufc to service_role;

-- ── report ─────────────────────────────────────────────────────────────────
select 1 as row, 'ufc.events / ufc.bouts exist' as check,
       case when to_regclass('ufc.events') is not null and to_regclass('ufc.bouts') is not null
            then 'ok' else 'CHECK THIS' end as result
union all select 2, 'live state, round stats and snapshots exist',
       case when to_regclass('ufc.fight_live_state') is not null
             and to_regclass('ufc.fight_round_stats') is not null
             and to_regclass('ufc.fight_snapshots') is not null then 'ok' else 'CHECK THIS' end
union all select 3, 'fighter aliases and baselines exist',
       case when to_regclass('ufc.fighter_aliases') is not null
             and to_regclass('ufc.fighter_baselines') is not null then 'ok' else 'CHECK THIS' end
union all select 4, 'bout markets, captures and rejections exist',
       case when to_regclass('ufc.bout_markets') is not null
             and to_regclass('ufc.market_captures') is not null
             and to_regclass('ufc.market_rejections') is not null then 'ok' else 'CHECK THIS' end
union all select 5, 'RLS is enabled on every new research table',
       case when (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'ufc' and c.relkind = 'r' and c.relrowsecurity
                     and c.relname in ('events','bouts','fight_live_state','fight_round_stats','fight_snapshots',
                                       'fighter_aliases','fighter_baselines','bout_markets','market_captures',
                                       'market_rejections','pipeline_runs','live_locks')) = 12
            then 'ok' else 'CHECK THIS' end
union all select 6, 'anon and authenticated may read the research tables',
       case when (select count(*) from pg_policies where schemaname = 'ufc' and cmd = 'SELECT'
                   and 'anon' = any(roles) and 'authenticated' = any(roles)) >= 11
            then 'ok' else 'CHECK THIS' end
union all select 7, 'no client write policy exists anywhere in the contract',
       case when not exists (select 1 from pg_policies where schemaname = 'ufc'
                              and cmd in ('INSERT','UPDATE','DELETE','ALL')
                              and ('anon' = any(roles) or 'authenticated' = any(roles)))
            then 'ok' else 'CHECK THIS' end
union all select 8, 'live_locks is unreachable from anon/authenticated',
       case when not exists (select 1 from information_schema.role_table_grants
                              where table_schema = 'ufc' and table_name = 'live_locks'
                                and grantee in ('anon','authenticated'))
            then 'ok' else 'CHECK THIS' end
union all select 9, 'lock routines are security definer and revoked from clients',
       case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'ufc' and p.proname in ('acquire_live_lock','release_live_lock') and p.prosecdef) = 2
             and not has_function_privilege('anon', 'ufc.acquire_live_lock(text,text,integer)', 'execute')
             and not has_function_privilege('authenticated', 'ufc.acquire_live_lock(text,text,integer)', 'execute')
            then 'ok' else 'CHECK THIS' end
union all select 10, 'pipeline_status view exists',
       case when to_regclass('ufc.pipeline_status') is not null then 'ok' else 'CHECK THIS' end
union all select 11, 'lookup indexes installed',
       case when to_regclass('ufc.ufc_bouts_event_idx') is not null
             and to_regclass('ufc.ufc_live_state_event_idx') is not null
             and to_regclass('ufc.ufc_snapshots_bout_idx') is not null
             and to_regclass('ufc.ufc_market_captures_bout_idx') is not null
             and to_regclass('ufc.ufc_pipeline_runs_job_idx') is not null then 'ok' else 'CHECK THIS' end
union all select 12, 'snapshot and capture dedup constraints installed',
       case when (select count(*) from pg_constraint
                   where conname in ('ufc_snapshots_dedup','ufc_market_captures_dedup','ufc_market_rejections_key',
                                     'ufc_bout_markets_fixture_key','ufc_bouts_provider_key','ufc_events_provider_key')) = 6
            then 'ok' else 'CHECK THIS' end
union all select 13, 'service_role may write the ufc.meta ledger',
       case when has_table_privilege('service_role', 'ufc.meta', 'INSERT')
             and has_table_privilege('service_role', 'ufc.meta', 'UPDATE') then 'ok' else 'CHECK THIS' end
union all select 14, 'ufc schema is exposed to the API (project setting, not checkable here)',
       'ok (confirm Supabase > API > Exposed schemas lists ufc — the fighter table already reads through it)'
order by row;
