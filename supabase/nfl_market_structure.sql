-- =============================================================================
-- nfl_market_structure.sql — the NFL Market Structure layers that live in the
-- database. docs/market-structure/README.md
--
-- WHAT IT ADDS (additive only: no existing table, column or function changes)
--   market_structure_alerts   append-only: every Failure / Warning the snapshot
--                             job and the contest sync raise, named and dated
--   nfl_team_divisions        the 32 clubs, conference and division (seeded;
--                             current alignment, in force since 2002)
--   nfl_margin_frequency      the empirical distribution of final margins by
--                             window (full, recent_2023) and basis (abs,
--                             fav_signed), versioned by computed_at,
--                             append-only; loaded from the committed artifact
--                             football/market_structure/nfl.json
--   half_point_value(line, window)
--                             the push probability at a spread and the mass
--                             that moves half a point either way. Parity with
--                             lib/edgedesk_market_structure.js halfPoint()
--   nfl_two_point_weekly      the league's two-point tries per week (Drift)
--   market_snapshot_config    the freeze per sport: NFL Thursday 13:00
--                             America/New_York by default
--   nfl_line_snapshots        append-only: the consensus main spread of every
--                             game on that week's slate at the freeze
--   nfl_consensus_spread_at(event, at)
--                             one rule for the snapshot, the current number and
--                             the close: the latest capture pass at or before
--                             `at` in public.signal_ticks, the home side's main
--                             line (most books, de-vigged fair nearest even)
--   nfl_line_snapshot_take() / _backfill()
--                             the job pg_cron runs (nfl_market_structure_cron.sql)
--   nfl_snapshot_board(from, to)
--                             snapshot → current → close, the delta, the key
--                             numbers touched, the flag, and the CLV of the
--                             snapshot price on the side the market moved toward
--
-- WHAT IT DOES NOT DO
--   It changes no projection, spread, probability, EV, ranking or grade, and it
--   writes nothing to signals, signal_ticks, model_predictions or any record
--   table. Everything here is T0 (observed) or T2 (deterministic) and is read
--   by the Market Structure section and the EXPERIMENTAL studies only.
--   Injury timing is NOT here: EdgeDesk does not own a timestamped status
--   history (nflverse date_modified is null for 2026), so the card shows that
--   section as Coming Soon rather than guessing.
--
-- REQUIRES public.signals and public.signal_ticks (capture; capture_v9 for the
-- (sig_key, created_at) index). Uses collective.fg2_event_links when present
-- (migrations/20260928120000_football_grading_v2.sql) for canonical game ids.
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

do $req$ begin
  if to_regclass('public.signals') is null or to_regclass('public.signal_ticks') is null then
    raise exception 'nfl_market_structure.sql needs public.signals and public.signal_ticks (the capture tables): apply capture first';
  end if;
end $req$;

begin;

-- 1 ---- alerts ----------------------------------------------------------------
create table if not exists public.market_structure_alerts (
  id         bigserial primary key,
  module     text not null check (module in ('nfl_line_snapshot', 'circa_ownership', 'nfl_market_structure_sync')),
  severity   text not null check (severity in ('FAILURE', 'WARNING', 'INFO')),
  code       text not null,
  message    text not null,
  detail     jsonb,
  created_at timestamptz not null default now()
);
create index if not exists market_structure_alerts_module_idx on public.market_structure_alerts (module, created_at desc);
comment on table public.market_structure_alerts is
  'Append-only. A Failure here means the module published nothing complete for that run; the card reads the latest row per module and says so.';

create or replace function public.market_structure_keep() returns trigger language plpgsql as $k$
begin raise exception '%: % is refused — this table is append-only; a correction is a new row', tg_table_name, tg_op; end $k$;

drop trigger if exists market_structure_alerts_frozen on public.market_structure_alerts;
create trigger market_structure_alerts_frozen before update or delete on public.market_structure_alerts for each row execute function public.market_structure_keep();
drop trigger if exists market_structure_alerts_no_truncate on public.market_structure_alerts;
create trigger market_structure_alerts_no_truncate before truncate on public.market_structure_alerts for each statement execute function public.market_structure_keep();

create or replace function public.market_structure_alert(p_module text, p_severity text, p_code text, p_message text, p_detail jsonb default null)
returns bigint language sql security definer set search_path = public as $a$
  insert into public.market_structure_alerts (module, severity, code, message, detail) values (p_module, p_severity, p_code, p_message, p_detail) returning id
$a$;

-- 2 ---- divisions -------------------------------------------------------------
create table if not exists public.nfl_team_divisions (
  team_code         text primary key,
  nflverse_code     text not null unique,
  team_name         text not null,
  conference        text not null check (conference in ('AFC', 'NFC')),
  division          text not null check (division ~ '^(AFC|NFC) (East|North|South|West)$'),
  valid_from_season integer not null default 2002,
  source            text not null default 'NFL alignment since 2002; codes = lib/football_identity.js (nflverse spells the Rams LA)'
);
insert into public.nfl_team_divisions (team_code, nflverse_code, team_name, conference, division) values
  ('BUF','BUF','Buffalo Bills','AFC','AFC East'), ('MIA','MIA','Miami Dolphins','AFC','AFC East'),
  ('NE','NE','New England Patriots','AFC','AFC East'), ('NYJ','NYJ','New York Jets','AFC','AFC East'),
  ('BAL','BAL','Baltimore Ravens','AFC','AFC North'), ('CIN','CIN','Cincinnati Bengals','AFC','AFC North'),
  ('CLE','CLE','Cleveland Browns','AFC','AFC North'), ('PIT','PIT','Pittsburgh Steelers','AFC','AFC North'),
  ('HOU','HOU','Houston Texans','AFC','AFC South'), ('IND','IND','Indianapolis Colts','AFC','AFC South'),
  ('JAX','JAX','Jacksonville Jaguars','AFC','AFC South'), ('TEN','TEN','Tennessee Titans','AFC','AFC South'),
  ('DEN','DEN','Denver Broncos','AFC','AFC West'), ('KC','KC','Kansas City Chiefs','AFC','AFC West'),
  ('LV','LV','Las Vegas Raiders','AFC','AFC West'), ('LAC','LAC','Los Angeles Chargers','AFC','AFC West'),
  ('DAL','DAL','Dallas Cowboys','NFC','NFC East'), ('NYG','NYG','New York Giants','NFC','NFC East'),
  ('PHI','PHI','Philadelphia Eagles','NFC','NFC East'), ('WAS','WAS','Washington Commanders','NFC','NFC East'),
  ('CHI','CHI','Chicago Bears','NFC','NFC North'), ('DET','DET','Detroit Lions','NFC','NFC North'),
  ('GB','GB','Green Bay Packers','NFC','NFC North'), ('MIN','MIN','Minnesota Vikings','NFC','NFC North'),
  ('ATL','ATL','Atlanta Falcons','NFC','NFC South'), ('CAR','CAR','Carolina Panthers','NFC','NFC South'),
  ('NO','NO','New Orleans Saints','NFC','NFC South'), ('TB','TB','Tampa Bay Buccaneers','NFC','NFC South'),
  ('ARI','ARI','Arizona Cardinals','NFC','NFC West'), ('LAR','LA','Los Angeles Rams','NFC','NFC West'),
  ('SF','SF','San Francisco 49ers','NFC','NFC West'), ('SEA','SEA','Seattle Seahawks','NFC','NFC West')
on conflict (team_code) do nothing;

-- 3 ---- margin frequency ------------------------------------------------------
create table if not exists public.nfl_margin_frequency (
  window_label text not null,
  basis        text not null check (basis in ('abs', 'fav_signed')),
  margin       integer not null,
  games        integer not null check (games >= 0),
  frequency    numeric not null check (frequency >= 0 and frequency <= 1),
  n_window     integer not null check (n_window > 0),
  first_season integer,
  last_season  integer,
  computed_at  timestamptz not null,
  source       text not null,
  primary key (window_label, basis, computed_at, margin),
  constraint nfl_margin_frequency_abs_nonneg check (basis <> 'abs' or margin >= 0)
);
comment on table public.nfl_margin_frequency is
  'Final NFL margins from settled games EdgeDesk owns (football/pricing/lines_nfl.json). abs = |home - away|; fav_signed = the closing favourite minus the underdog (negative: the favourite lost; pick''em closes excluded). One version per computed_at; the _current view reads the latest. Append-only.';
drop trigger if exists nfl_margin_frequency_frozen on public.nfl_margin_frequency;
create trigger nfl_margin_frequency_frozen before update or delete on public.nfl_margin_frequency for each row execute function public.market_structure_keep();
drop trigger if exists nfl_margin_frequency_no_truncate on public.nfl_margin_frequency;
create trigger nfl_margin_frequency_no_truncate before truncate on public.nfl_margin_frequency for each statement execute function public.market_structure_keep();

create or replace view public.nfl_margin_frequency_current as
  select f.* from public.nfl_margin_frequency f
   where f.computed_at = (select max(x.computed_at) from public.nfl_margin_frequency x where x.window_label = f.window_label and x.basis = f.basis);

-- The value of a half point at `p_line`, held the way the BETTOR holds it
-- (-6 = laying six, +6 = getting six). A side pushes when the favourite wins by
-- exactly |line|, so the favourite-signed mass at |line| is the one that moves.
-- From a whole number: up (toward the bettor) turns pushes into wins, down turns
-- them into losses. From a half point: up turns losses at the next whole number
-- into pushes, down turns wins at the previous one into pushes. Shares of games
-- in the window — never a cover probability for any one game. (`window` is a
-- reserved word, hence p_window; positional calls read half_point_value(-6, 'full').)
create or replace function public.half_point_value(p_line numeric, p_window text default 'full')
returns table (line numeric, window_label text, games integer, computed_at timestamptz, push_prob numeric,
  up_line numeric, up_effect text, up_moved_mass numeric, up_win_change numeric, up_push_change numeric, up_loss_change numeric, up_half_push_change numeric,
  down_line numeric, down_effect text, down_moved_mass numeric, down_win_change numeric, down_push_change numeric, down_loss_change numeric, down_half_push_change numeric)
language sql stable set search_path = public as $h$
  with cur as (select margin, frequency, n_window, computed_at from public.nfl_margin_frequency_current where window_label = p_window and basis = 'fav_signed'),
  meta as (select max(n_window) as n, max(computed_at) as at from cur),
  l as (select round(p_line * 2) / 2 as v),
  w as (select v, (v = trunc(v)) as whole from l),
  pm as (
    select w.v, w.whole,
      coalesce((select c.frequency from cur c where w.whole and c.margin = abs(w.v)::int), 0) as at_line,
      coalesce((select c.frequency from cur c where not w.whole and c.margin = abs(w.v + 0.5)::int), 0) as at_up,
      coalesce((select c.frequency from cur c where not w.whole and c.margin = abs(w.v - 0.5)::int), 0) as at_dn
    from w)
  select pm.v, p_window, meta.n, meta.at, round(pm.at_line, 6),
    pm.v + 0.5, case when pm.whole then 'push_to_win' else 'loss_to_push' end,
    round(case when pm.whole then pm.at_line else pm.at_up end, 6),
    round(case when pm.whole then pm.at_line else 0 end, 6),
    round(case when pm.whole then -pm.at_line else pm.at_up end, 6),
    round(case when pm.whole then 0 else -pm.at_up end, 6),
    round(0.5 * case when pm.whole then pm.at_line else pm.at_up end, 7),
    pm.v - 0.5, case when pm.whole then 'push_to_loss' else 'win_to_push' end,
    round(case when pm.whole then pm.at_line else pm.at_dn end, 6),
    round(case when pm.whole then 0 else -pm.at_dn end, 6),
    round(case when pm.whole then -pm.at_line else pm.at_dn end, 6),
    round(case when pm.whole then pm.at_line else 0 end, 6),
    round(-0.5 * case when pm.whole then pm.at_line else pm.at_dn end, 7)
  from pm, meta
  where meta.n is not null
$h$;

-- 4 ---- two-point tries (Drift) -----------------------------------------------
create table if not exists public.nfl_two_point_weekly (
  season       integer not null,
  season_type  text not null check (season_type in ('REG', 'POST')),
  week         integer not null,
  games        integer not null,
  xp_att       integer not null,
  two_pt_att   integer not null,
  two_pt_made  integer not null,
  touchdowns   integer not null,
  share        numeric,
  computed_at  timestamptz not null,
  source       text not null,
  primary key (season, season_type, week, computed_at)
);
drop trigger if exists nfl_two_point_weekly_frozen on public.nfl_two_point_weekly;
create trigger nfl_two_point_weekly_frozen before update or delete on public.nfl_two_point_weekly for each row execute function public.market_structure_keep();
drop trigger if exists nfl_two_point_weekly_no_truncate on public.nfl_two_point_weekly;
create trigger nfl_two_point_weekly_no_truncate before truncate on public.nfl_two_point_weekly for each statement execute function public.market_structure_keep();
create or replace view public.nfl_two_point_weekly_current as
  select distinct on (season, season_type, week) * from public.nfl_two_point_weekly order by season, season_type, week, computed_at desc;
create or replace view public.nfl_two_point_season as
  select season, count(*)::int as weeks, sum(games)::int as games, sum(xp_att)::int as xp_att, sum(two_pt_att)::int as two_pt_att,
         sum(two_pt_made)::int as two_pt_made, round(sum(two_pt_att)::numeric / nullif(sum(xp_att + two_pt_att), 0), 4) as share
    from public.nfl_two_point_weekly_current where season_type = 'REG' group by season;

-- 5 ---- the loader: the committed artifact into the two tables above -----------
-- A version is written only when it differs from the current one, so a re-sync
-- of the same artifact writes nothing. Service role only.
create or replace function public.nfl_market_structure_load(p_artifact jsonb)
returns jsonb language plpgsql security definer set search_path = public as $l$
declare
  at_ timestamptz := (p_artifact ->> 'generated_at')::timestamptz;
  w jsonb; b text; rows_ jsonb; n_mf int := 0; n_tp int := 0; k int; same boolean; src text := 'football/market_structure/nfl.json';
begin
  if p_artifact ->> 'schema' is distinct from 'edgedesk_nfl_market_structure_v1' then
    raise exception 'nfl_market_structure_load: not an edgedesk_nfl_market_structure_v1 artifact';
  end if;
  for w in select * from jsonb_array_elements(p_artifact -> 'margin_frequency' -> 'windows') loop
    foreach b in array array['abs', 'fav_signed'] loop
      rows_ := w -> b -> 'rows';
      continue when rows_ is null or jsonb_array_length(rows_) = 0;
      select coalesce((select jsonb_agg(jsonb_build_object('margin', c.margin, 'games', c.games) order by c.margin)
                         from public.nfl_margin_frequency_current c where c.window_label = w ->> 'window_label' and c.basis = b), '[]'::jsonb)
           = (select jsonb_agg(jsonb_build_object('margin', (x ->> 'margin')::int, 'games', (x ->> 'games')::int) order by (x ->> 'margin')::int)
                from jsonb_array_elements(rows_) x)
        into same;
      continue when same;
      insert into public.nfl_margin_frequency (window_label, basis, margin, games, frequency, n_window, first_season, last_season, computed_at, source)
      select w ->> 'window_label', b, (x ->> 'margin')::int, (x ->> 'games')::int, (x ->> 'frequency')::numeric,
             (w -> b ->> 'n_games')::int, (w ->> 'first_season')::int, (w ->> 'last_season')::int, at_, src
        from jsonb_array_elements(rows_) x
      on conflict do nothing;
      get diagnostics k = row_count;
      n_mf := n_mf + k;
    end loop;
  end loop;
  insert into public.nfl_two_point_weekly (season, season_type, week, games, xp_att, two_pt_att, two_pt_made, touchdowns, share, computed_at, source)
  select (x ->> 'season')::int, x ->> 'season_type', (x ->> 'week')::int, (x ->> 'games')::int, (x ->> 'xp_att')::int, (x ->> 'two_pt_att')::int,
         (x ->> 'two_pt_made')::int, (x ->> 'touchdowns')::int, (x ->> 'share')::numeric, at_, src
    from jsonb_array_elements(coalesce(p_artifact -> 'two_point' -> 'weeks', '[]'::jsonb)) x
   where x ->> 'season_type' in ('REG', 'POST')
     and not exists (select 1 from public.nfl_two_point_weekly_current c
                      where c.season = (x ->> 'season')::int and c.season_type = x ->> 'season_type' and c.week = (x ->> 'week')::int
                        and (c.games, c.xp_att, c.two_pt_att, c.two_pt_made, c.touchdowns)
                            = ((x ->> 'games')::int, (x ->> 'xp_att')::int, (x ->> 'two_pt_att')::int, (x ->> 'two_pt_made')::int, (x ->> 'touchdowns')::int))
  on conflict do nothing;
  get diagnostics n_tp = row_count;
  return jsonb_build_object('computed_at', at_, 'margin_rows_written', n_mf, 'two_point_weeks_written', n_tp);
end $l$;

-- 6 ---- the snapshot ----------------------------------------------------------
create table if not exists public.market_snapshot_config (
  sport_key               text primary key,
  dow                     integer not null check (dow between 0 and 6),
  local_time              time not null,
  tz                      text not null,
  horizon_days            integer not null default 6 check (horizon_days between 1 and 13),
  max_capture_age_minutes integer not null default 420 check (max_capture_age_minutes > 0),
  enabled                 boolean not null default true,
  note                    text
);
insert into public.market_snapshot_config (sport_key, dow, local_time, tz, note)
values ('americanfootball_nfl', 4, '13:00', 'America/New_York',
        'Contest freeze: Thursday 1:00 PM Eastern, the slate kicking off within horizon_days after it. A capture pass older than max_capture_age_minutes at the freeze is reported stale, never used.')
on conflict (sport_key) do nothing;

create table if not exists public.nfl_line_snapshots (
  id                  bigserial primary key,
  sport_key           text not null,
  snapshot_at         timestamptz not null,
  taken_at            timestamptz not null default now(),
  event_id            text not null,
  canonical_game_id   text,
  home_team           text,
  away_team           text,
  commence_time       timestamptz,
  status              text not null check (status in ('ok', 'no_capture', 'stale_capture', 'no_main_line')),
  pass_at             timestamptz,
  capture_age_minutes numeric,
  home_spread         numeric,
  fair_home           numeric,
  n_books             integer,
  best_dec_home       numeric,
  best_dec_away       numeric,
  sig_key_home        text,
  sig_key_away        text,
  books               text[],
  rule                text not null,
  constraint nfl_line_snapshots_once unique (sport_key, event_id, snapshot_at),
  constraint nfl_line_snapshots_ok_has_line check (status <> 'ok' or (home_spread is not null and pass_at is not null and pass_at <= snapshot_at))
);
create index if not exists nfl_line_snapshots_kick_idx on public.nfl_line_snapshots (sport_key, commence_time);
comment on table public.nfl_line_snapshots is
  'Append-only. The consensus main spread at the freeze, read from capture history at or before snapshot_at, so a late or backfilled run records the same number a punctual one would (taken_at says which). home_spread is what the HOME side lays (negative = home favoured).';
drop trigger if exists nfl_line_snapshots_frozen on public.nfl_line_snapshots;
create trigger nfl_line_snapshots_frozen before update or delete on public.nfl_line_snapshots for each row execute function public.market_structure_keep();
drop trigger if exists nfl_line_snapshots_no_truncate on public.nfl_line_snapshots;
create trigger nfl_line_snapshots_no_truncate before truncate on public.nfl_line_snapshots for each statement execute function public.market_structure_keep();

-- The freeze most recently due at or before p_at, in the sport's own zone (DST-correct).
create or replace function public.market_snapshot_instant(p_at timestamptz, p_sport text default 'americanfootball_nfl')
returns timestamptz language plpgsql stable set search_path = public as $i$
declare c public.market_snapshot_config; loc timestamp; d date; cand timestamp;
begin
  select * into c from public.market_snapshot_config where sport_key = p_sport;
  if not found then return null; end if;
  loc := p_at at time zone c.tz;
  d := loc::date - ((extract(dow from loc)::int - c.dow + 7) % 7);
  cand := d + c.local_time;
  if cand > loc then cand := cand - interval '7 days'; end if;
  return cand at time zone c.tz;
end $i$;

-- Keys a move touched: closed interval on the signed line, a key counting at +k
-- or -k. Parity with lib/edgedesk_market_structure.js keysCrossed().
create or replace function public.nfl_keys_crossed(p_from numeric, p_to numeric)
returns integer[] language sql immutable as $x$
  select case when p_from is null or p_to is null or p_from = p_to then '{}'::int[] else
    coalesce((select array_agg(k order by k) from unnest(array[3, 6, 7, 10, 14]) k
               where (k between least(p_from, p_to) and greatest(p_from, p_to)) or (-k between least(p_from, p_to) and greatest(p_from, p_to))), '{}'::int[]) end
$x$;

-- The consensus main spread of one event as capture saw it at `p_at`.
create or replace function public.nfl_consensus_spread_at(p_event_id text, p_at timestamptz, p_max_age_minutes integer default 420)
returns table (event_id text, home_team text, away_team text, commence_time timestamptz, status text, pass_at timestamptz, age_minutes numeric,
  home_spread numeric, fair_home numeric, n_books integer, best_dec_home numeric, best_dec_away numeric, sig_key_home text, sig_key_away text, candidates integer)
language plpgsql stable security definer set search_path = public as $c$
declare ev record; pass timestamptz; h record; a record; n int;
begin
  select s.event_id, s.home_team, s.away_team, s.commence_time into ev
    from public.signals s where s.event_id = p_event_id and s.market = 'spreads' order by s.last_seen_at desc nulls last limit 1;
  if not found then
    return query select p_event_id, null::text, null::text, null::timestamptz, 'no_capture'::text, null::timestamptz, null::numeric,
      null::numeric, null::numeric, null::int, null::numeric, null::numeric, null::text, null::text, 0; return;
  end if;
  select max(t.at) into pass from public.signals s
    cross join lateral (select max(x.created_at) as at from public.signal_ticks x where x.sig_key = s.sig_key and x.created_at <= p_at) t
   where s.event_id = p_event_id and s.market = 'spreads';
  if pass is null or p_at - pass > make_interval(mins => p_max_age_minutes) then
    return query select ev.event_id, ev.home_team, ev.away_team, ev.commence_time,
      (case when pass is null then 'no_capture' else 'stale_capture' end)::text, pass,
      case when pass is null then null else round(extract(epoch from (p_at - pass)) / 60.0, 1) end,
      null::numeric, null::numeric, null::int, null::numeric, null::numeric, null::text, null::text, 0; return;
  end if;
  -- the home side's rows on that pass, near even money after the de-vig: a
  -- book's main line, never an alternate rung; the most books, then the fair
  -- nearest 50%, then the smaller number
  select count(*) into n from public.signals s join public.signal_ticks t on t.sig_key = s.sig_key and t.created_at = pass
   where s.event_id = p_event_id and s.market = 'spreads' and s.selection = ev.home_team and s.point is not null
     and t.sharp_fair between 0.35 and 0.65 and coalesce(t.n_books, 0) >= 1;
  select s.sig_key, s.point, t.sharp_fair, t.best_dec, t.n_books into h
    from public.signals s join public.signal_ticks t on t.sig_key = s.sig_key and t.created_at = pass
   where s.event_id = p_event_id and s.market = 'spreads' and s.selection = ev.home_team and s.point is not null
     and t.sharp_fair between 0.35 and 0.65 and coalesce(t.n_books, 0) >= 1
   order by t.n_books desc, abs(t.sharp_fair - 0.5), abs(s.point) limit 1;
  if not found then
    return query select ev.event_id, ev.home_team, ev.away_team, ev.commence_time, 'no_main_line'::text, pass,
      round(extract(epoch from (p_at - pass)) / 60.0, 1), null::numeric, null::numeric, null::int, null::numeric, null::numeric, null::text, null::text, 0; return;
  end if;
  select s.sig_key, t.best_dec into a
    from public.signals s join public.signal_ticks t on t.sig_key = s.sig_key and t.created_at = pass
   where s.event_id = p_event_id and s.market = 'spreads' and s.selection = ev.away_team and s.point = -h.point limit 1;
  return query select ev.event_id, ev.home_team, ev.away_team, ev.commence_time, 'ok'::text, pass, round(extract(epoch from (p_at - pass)) / 60.0, 1),
    h.point, h.sharp_fair, h.n_books, h.best_dec, a.best_dec, h.sig_key, a.sig_key, n;
end $c$;

-- the canonical game for an Odds API event, when the football grading layer linked it
create or replace function public.nfl_canonical_game_id(p_event_id text)
returns text language plpgsql stable security definer set search_path = public as $g$
declare g text;
begin
  if to_regclass('collective.fg2_event_links') is null then return null; end if;
  execute 'select canonical_game_id from collective.fg2_event_links where source = ''edgedesk_capture'' and source_event_id = $1 and status = ''linked'' limit 1'
    into g using p_event_id;
  return g;
end $g$;

-- Take the freeze due at p_at for every event kicking off inside the horizon.
-- Idempotent: an event already frozen at that instant is skipped.
create or replace function public.nfl_line_snapshot_take(p_at timestamptz default now(), p_sport text default 'americanfootball_nfl')
returns jsonb language plpgsql security definer set search_path = public as $t$
declare c public.market_snapshot_config; snap timestamptz; e record; r record; ins int := 0; skip int := 0; st jsonb := '{}'::jsonb; books_ text[];
begin
  select * into c from public.market_snapshot_config where sport_key = p_sport;
  if not found or not c.enabled then return jsonb_build_object('skipped', 'no enabled snapshot config for ' || p_sport); end if;
  snap := public.market_snapshot_instant(p_at, p_sport);
  for e in select s.event_id, min(s.commence_time) as kick from public.signals s
            where s.sport_key = p_sport and s.market = 'spreads' and s.commence_time > snap and s.commence_time <= snap + make_interval(days => c.horizon_days)
            group by s.event_id loop
    if exists (select 1 from public.nfl_line_snapshots x where x.sport_key = p_sport and x.event_id = e.event_id and x.snapshot_at = snap) then skip := skip + 1; continue; end if;
    select * into r from public.nfl_consensus_spread_at(e.event_id, snap, c.max_capture_age_minutes);
    books_ := null;
    if r.status = 'ok' and to_regclass('public.book_quote_ticks') is not null then
      select array_agg(distinct q.book_key order by q.book_key) into books_ from public.book_quote_ticks q
       where q.sig_key = r.sig_key_home and q.seen_at <= snap and q.seen_at > snap - make_interval(mins => c.max_capture_age_minutes) and q.book_key is not null;
    end if;
    insert into public.nfl_line_snapshots (sport_key, snapshot_at, event_id, canonical_game_id, home_team, away_team, commence_time, status, pass_at,
      capture_age_minutes, home_spread, fair_home, n_books, best_dec_home, best_dec_away, sig_key_home, sig_key_away, books, rule)
    values (p_sport, snap, e.event_id, public.nfl_canonical_game_id(e.event_id), r.home_team, r.away_team, coalesce(r.commence_time, e.kick), r.status, r.pass_at,
      r.age_minutes, r.home_spread, r.fair_home, r.n_books, r.best_dec_home, r.best_dec_away, r.sig_key_home, r.sig_key_away, books_,
      'latest capture pass at or before the freeze (max age ' || c.max_capture_age_minutes || ' min); home main line = most books, de-vigged fair nearest 50%, then the smaller number')
    on conflict on constraint nfl_line_snapshots_once do nothing;
    ins := ins + 1;
    st := jsonb_set(st, array[r.status], to_jsonb(coalesce((st ->> r.status)::int, 0) + 1));
  end loop;
  if ins > 0 and coalesce((st ->> 'ok')::int, 0) = 0 then
    perform public.market_structure_alert('nfl_line_snapshot', 'FAILURE', 'no_line_at_freeze',
      'No game on the slate had a usable captured spread at the freeze: nothing published as a snapshot line', jsonb_build_object('snapshot_at', snap, 'statuses', st));
  elsif ins > 0 and coalesce((st ->> 'ok')::int, 0) < ins then
    perform public.market_structure_alert('nfl_line_snapshot', 'WARNING', 'partial_freeze',
      'Some games had no usable captured spread at the freeze; they show the reason instead of a line', jsonb_build_object('snapshot_at', snap, 'statuses', st));
  end if;
  return jsonb_build_object('snapshot_at', snap, 'events_written', ins, 'already_frozen', skip, 'statuses', st);
end $t$;

-- Reconstruct the freezes of past weeks from capture history (service role).
create or replace function public.nfl_line_snapshot_backfill(p_from timestamptz, p_to timestamptz default now(), p_sport text default 'americanfootball_nfl')
returns jsonb language plpgsql security definer set search_path = public as $b$
declare at_ timestamptz; out_ jsonb := '[]'::jsonb;
begin
  at_ := public.market_snapshot_instant(p_from, p_sport);
  if at_ < p_from then at_ := at_ + interval '7 days'; end if;
  while at_ <= p_to loop
    out_ := out_ || public.nfl_line_snapshot_take(at_, p_sport);
    at_ := public.market_snapshot_instant(at_ + interval '7 days 1 hour', p_sport);
  end loop;
  return out_;
end $b$;

-- The board: snapshot → current (pregame) → close (kicked off), the move, the
-- flag, and the CLV of the snapshot price on the side the market moved toward:
-- entry decimal × closing de-vigged fair − 1, the close pipeline's own formula
-- (supabase/functions/close/index.ts decideClose), its close where it priced
-- that number, else the last capture tick at or before kickoff. p_now is the
-- moment the board is read as of (a game after it is pregame).
create or replace function public.nfl_snapshot_board(p_from timestamptz default now() - interval '10 days', p_to timestamptz default now() + interval '9 days',
  p_now timestamptz default now())
returns table (event_id text, canonical_game_id text, home_team text, away_team text, commence_time timestamptz, snapshot_at timestamptz, snapshot_status text,
  snapshot_backfilled boolean, snap_home_spread numeric, snap_fair_home numeric, snap_n_books integer, snap_books text[], snap_pass_at timestamptz,
  current_status text, current_at timestamptz, current_home_spread numeric, current_delta numeric, current_crossed integer[], current_flagged boolean,
  close_status text, close_at timestamptz, close_home_spread numeric, close_delta numeric, close_crossed integer[], close_flagged boolean,
  moved_toward text, clv numeric, clv_source text, clv_reason text)
language plpgsql stable security definer set search_path = public as $d$
declare s public.nfl_line_snapshots; age int;
  c_status text; c_spread numeric; l_status text; l_spread numeric;
  toward text; sig text; entry numeric; fair numeric; src text; why text; d numeric;
begin
  select coalesce(max(m.max_capture_age_minutes), 420) into age from public.market_snapshot_config m where m.sport_key = 'americanfootball_nfl';
  for s in select distinct on (x.event_id) x.* from public.nfl_line_snapshots x
            where x.sport_key = 'americanfootball_nfl' and x.commence_time between p_from and p_to
            order by x.event_id, x.snapshot_at desc loop
    c_status := null; c_spread := null; l_status := null; l_spread := null;
    toward := null; entry := null; fair := null; src := null; why := null;
    if s.commence_time > p_now then
      select q.status, q.home_spread into c_status, c_spread from public.nfl_consensus_spread_at(s.event_id, p_now, age) q;
    else
      select q.status, q.home_spread into l_status, l_spread from public.nfl_consensus_spread_at(s.event_id, s.commence_time, age) q;
    end if;
    if s.status <> 'ok' then why := 'no_snapshot_line';
    elsif l_status is null then why := 'not_closed';
    elsif l_status <> 'ok' then why := 'no_close_line';
    else
      d := l_spread - s.home_spread;
      toward := case when d < 0 then 'home' when d > 0 then 'away' end;
      if toward is null then why := 'no_move';
      else
        sig := case when toward = 'home' then s.sig_key_home else s.sig_key_away end;
        entry := case when toward = 'home' then s.best_dec_home else s.best_dec_away end;
        select g.closing_sharp_fair into fair from public.signals g where g.sig_key = sig;
        src := 'close_pipeline';
        if fair is null then
          select t.sharp_fair into fair from public.signal_ticks t
           where t.sig_key = sig and t.created_at <= s.commence_time and t.created_at > s.commence_time - interval '6 hours' order by t.created_at desc limit 1;
          src := 'last_tick';
        end if;
        if entry is null or not (entry > 1.01 and entry < 51) then why := 'no_entry_price'; src := null;
        elsif fair is null then why := 'no_close_reference'; src := null;
        elsif not (fair > 0 and fair < 1) then why := 'invalid_close_fair'; src := null; fair := null;
        end if;
      end if;
    end if;
    return query select s.event_id, s.canonical_game_id, s.home_team, s.away_team, s.commence_time, s.snapshot_at, s.status,
      s.taken_at > s.snapshot_at + interval '1 hour', s.home_spread, s.fair_home, s.n_books, s.books, s.pass_at,
      c_status, case when c_status is not null then p_now end, c_spread, c_spread - s.home_spread,
      case when c_status = 'ok' and s.status = 'ok' then public.nfl_keys_crossed(s.home_spread, c_spread) end,
      case when c_status = 'ok' and s.status = 'ok' then abs(c_spread - s.home_spread) >= 1 or cardinality(public.nfl_keys_crossed(s.home_spread, c_spread)) > 0 end,
      l_status, case when l_status is not null then s.commence_time end, l_spread, l_spread - s.home_spread,
      case when l_status = 'ok' and s.status = 'ok' then public.nfl_keys_crossed(s.home_spread, l_spread) end,
      case when l_status = 'ok' and s.status = 'ok' then abs(l_spread - s.home_spread) >= 1 or cardinality(public.nfl_keys_crossed(s.home_spread, l_spread)) > 0 end,
      toward, case when why is null and entry is not null and fair is not null then round(entry * fair - 1, 5) end, src, why;
  end loop;
end $d$;

-- 7 ---- who reads, who writes -------------------------------------------------
alter table public.market_structure_alerts enable row level security;
alter table public.nfl_team_divisions enable row level security;
alter table public.nfl_margin_frequency enable row level security;
alter table public.nfl_two_point_weekly enable row level security;
alter table public.market_snapshot_config enable row level security;
alter table public.nfl_line_snapshots enable row level security;
do $p$ declare t text; begin
  foreach t in array array['market_structure_alerts', 'nfl_team_divisions', 'nfl_margin_frequency', 'nfl_two_point_weekly', 'market_snapshot_config', 'nfl_line_snapshots'] loop
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to anon, authenticated using (true)', t || '_read', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to anon, authenticated', t);
  end loop;
end $p$;
grant select on public.nfl_margin_frequency_current, public.nfl_two_point_weekly_current, public.nfl_two_point_season to anon, authenticated;
revoke all on function public.market_structure_alert(text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.nfl_market_structure_load(jsonb) from public, anon, authenticated;
revoke all on function public.nfl_line_snapshot_take(timestamptz, text) from public, anon, authenticated;
revoke all on function public.nfl_line_snapshot_backfill(timestamptz, timestamptz, text) from public, anon, authenticated;
revoke all on function public.nfl_consensus_spread_at(text, timestamptz, integer) from public, anon, authenticated;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.nfl_market_structure_load(jsonb) to service_role';
    execute 'grant execute on function public.nfl_line_snapshot_take(timestamptz, text) to service_role';
    execute 'grant execute on function public.nfl_line_snapshot_backfill(timestamptz, timestamptz, text) to service_role';
    execute 'grant execute on function public.market_structure_alert(text, text, text, text, jsonb) to service_role';
    execute 'grant select on public.market_structure_alerts, public.nfl_team_divisions, public.nfl_margin_frequency, public.nfl_two_point_weekly, '
         || 'public.market_snapshot_config, public.nfl_line_snapshots to service_role';
    execute 'grant update on public.market_snapshot_config to service_role';
  end if;
end $g$;
grant execute on function public.half_point_value(numeric, text) to anon, authenticated;
grant execute on function public.nfl_snapshot_board(timestamptz, timestamptz, timestamptz) to anon, authenticated;
grant execute on function public.nfl_keys_crossed(numeric, numeric) to anon, authenticated;
grant execute on function public.market_snapshot_instant(timestamptz, text) to anon, authenticated;

commit;

notify pgrst, 'reload schema';

-- THE REPORT. Every row should say ok.
select piece, state from (
  select '1 alerts table, append-only' as piece, case when to_regclass('public.market_structure_alerts') is not null
    and exists (select 1 from pg_trigger where tgname = 'market_structure_alerts_frozen') then 'ok' else 'CHECK THIS' end as state
  union all select '2 divisions: 32 clubs, 8 divisions of 4', case when (select count(*) from public.nfl_team_divisions) = 32
    and not exists (select 1 from public.nfl_team_divisions group by division having count(*) <> 4) then 'ok' else 'CHECK THIS' end
  union all select '3 margin frequency table + current view (rows appear after the first sync)', case when to_regclass('public.nfl_margin_frequency_current') is not null then 'ok' else 'CHECK THIS' end
  union all select '4 half_point_value(line, window)', case when to_regprocedure('public.half_point_value(numeric,text)') is not null then 'ok' else 'CHECK THIS' end
  union all select '5 two-point weekly + season views', case when to_regclass('public.nfl_two_point_season') is not null then 'ok' else 'CHECK THIS' end
  union all select '6 snapshot config: NFL Thursday 13:00 America/New_York', case when exists (select 1 from public.market_snapshot_config where sport_key = 'americanfootball_nfl') then 'ok' else 'CHECK THIS' end
  union all select '7 snapshots append-only', case when exists (select 1 from pg_trigger where tgname = 'nfl_line_snapshots_frozen')
    and exists (select 1 from pg_trigger where tgname = 'nfl_line_snapshots_no_truncate') then 'ok' else 'CHECK THIS' end
  union all select '8 keys crossed: 2.5 -> 3 touches 3, 4 -> 4.5 touches nothing', case when public.nfl_keys_crossed(-2.5, -3) = array[3] and public.nfl_keys_crossed(4, 4.5) = '{}'::int[] then 'ok' else 'CHECK THIS' end
  union all select '9 readers read, only the service role writes', case when has_table_privilege('anon', 'public.nfl_line_snapshots', 'select')
    and not has_table_privilege('anon', 'public.nfl_line_snapshots', 'insert')
    and not has_function_privilege('anon', 'public.nfl_line_snapshot_take(timestamptz,text)', 'execute')
    and not has_function_privilege('anon', 'public.nfl_market_structure_load(jsonb)', 'execute') then 'ok' else 'CHECK THIS' end
  union all select '10 the capture tick index the consensus reads through', case when exists (select 1 from pg_indexes where indexname = 'signal_ticks_sig_created_idx') then 'ok' else 'CHECK THIS (apply capture_v9_qualification.sql: without it every consensus read scans signal_ticks)' end
) r order by split_part(piece, ' ', 1)::int;
