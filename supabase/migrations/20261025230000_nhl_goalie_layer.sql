-- =============================================================================
-- nhl_goalie_layer.sql — NHL starting goalies as an Observed (T0) input, and
-- the versioned NHL game card built on them. docs/engine/NHL_GOALIES.md;
-- README §NHL starting goalies.
--
-- WHO WRITES. Only supabase/functions/nhl_goalie_sync (service_role). Every
-- table is APPEND-ONLY: an update, a delete or a truncate is refused by a
-- trigger, for service_role too. The one exception is the starter history's
-- is_current flag, which only the insert trigger may turn off (true -> false,
-- nothing else on the row may change). Readers (anon, authenticated) may
-- select; no client may write.
--
--   nhl_goalie_config         operator settings (freshness, the T-30 grace,
--                             the live goalie variant a card must name)
--   nhl_goalie_sync_runs      one row per run (ok / warn / error / skipped)
--   nhl_goalie_alerts         FAILURE / DEGRADED / DRIFT / WARNING, by run
--   nhl_goalie_starters       every observation of a starter: one row per
--                             game, team and source when it changes
--                             (daily_faceoff, nhl_api_boxscore, manual,
--                             edgedesk_projection) and the merged
--                             'consensus' row the card uses; the newest per
--                             (game, team, source) is_current
--   nhl_game_cards            every version of every game card: the pairing
--                             used, each side's status, the generation time,
--                             the pairing range, the edge gate, the Known
--                             Limitations and the change note. Old versions
--                             stay, for audit
--   nhl_card_edge_events      an edge seen against a price, attached to the
--                             card version that was CURRENT when it was seen
--                             (a trigger refuses any other)
--   nhl_card_edge_clv         the closing-line grade of one edge event, so CLV
--                             attaches to that version too
--
--   nhl_goalie_starters_current   the current rows for upcoming games
--   nhl_game_cards_current        the latest version per upcoming game
--   nhl_card_edge_clv_detail      edge -> card version -> CLV
--   nhl_goalie_readiness          the KPIs (one row): confirmed by T-30,
--                                 sync failures, source conflicts
--   nhl_goalie_meta               {job}_last_run rows for the pipeline ledger
--   nhl_goalie_card(game_id)      what one card shows, with freshness applied
--
-- THE RULES THE DATABASE HOLDS (not only the function):
--   * a card that is not Confirmed on both sides (or carries a conflict) must
--     show the pairing range and the line "Starter not confirmed. Numbers may
--     change.", and its edge gate is GATED;
--   * versions are 1, 2, 3 ... per game, each superseding the one before, each
--     generated before puck drop;
--   * a card names the live goalie variant (nhl_goalie_config) and the v1
--     model: the experimental v2 goalie rating cannot reach a live card;
--   * an edge event names the card version current at its detection time.
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

begin;

-- ---------------------------------------------------------------- the status enum
do $e$ begin
  if not exists (select 1 from pg_type where typname = 'nhl_goalie_status' and typnamespace = 'public'::regnamespace) then
    create type public.nhl_goalie_status as enum ('projected', 'likely', 'confirmed', 'unknown');
  end if;
end $e$;

create or replace function public.nhl_goalie_status_rank(s public.nhl_goalie_status)
returns int language sql immutable as $r$
  select case s when 'confirmed' then 3 when 'likely' then 2 when 'projected' then 1 else 0 end
$r$;

-- ---------------------------------------------------------------- the guard
create or replace function public.nhl_goalie_keep()
returns trigger language plpgsql as $k$
begin
  raise exception 'public.% is append-only: % refused (write a new row instead)', tg_table_name, tg_op;
end $k$;

-- ---------------------------------------------------------------- config
create table if not exists public.nhl_goalie_config (
  key        text primary key,
  value      text not null,
  note       text,
  updated_at timestamptz not null default now()
);
insert into public.nhl_goalie_config (key, value, note) values
  ('check_max_age_minutes', '150', 'the two-hourly cadence: a check older than this (with no skipped run after it) is stale'),
  ('pregame_check_max_age_minutes', '30', 'within three hours of puck drop the cadence is 15 minutes: a check older than this is stale'),
  ('t30_grace_minutes', '5', 'the T-30 pass runs on a 5-minute poke grid: "confirmed by T-30" counts observations fetched by T-30 plus this'),
  ('confirmed_by_t30_target_pct', '90', 'the readiness target: games with both starters Confirmed by T-30, over 7 days'),
  ('live_goalie_variant', 'xg_goalie_confirmed', 'the goalie-aware variant every live card must name (hockey/model/params/live.json); the v2 rating is experimental and may not'),
  ('live_model_prefix', 'edgedesk_nhl_v1:', 'every live card names a model with this prefix')
on conflict (key) do nothing;

-- ---------------------------------------------------------------- runs and alerts
create table if not exists public.nhl_goalie_sync_runs (
  run_id               uuid primary key default gen_random_uuid(),
  build                text,
  trigger              text not null default 'cron' check (trigger in ('cron', 'manual', 'test')),
  status               text not null check (status in ('ok', 'warn', 'error', 'skipped')),
  skipped_reason       text,
  started_at           timestamptz not null,
  finished_at          timestamptz not null default now(),
  due_kinds            text[] not null default '{}',
  final_pass_games     text[] not null default '{}',
  next_due_at          timestamptz,
  inputs_generated_at  timestamptz,
  games_considered     integer,
  daily_faceoff_ok     boolean,
  nhl_api_ok           boolean,
  observations_written integer,
  consensus_written    integer,
  conflicts_open       integer,
  unmatched            integer,
  cards_written        integer,
  cards_unchanged      integer,
  edge_events_written  integer,
  simulated            boolean not null default false,
  message              text,
  sources              jsonb not null default '{}'::jsonb,
  details              jsonb not null default '{}'::jsonb,
  check (finished_at >= started_at)
);
create index if not exists nhl_goalie_sync_runs_finished_idx on public.nhl_goalie_sync_runs (finished_at desc);

create table if not exists public.nhl_goalie_alerts (
  id         bigserial primary key,
  run_id     uuid references public.nhl_goalie_sync_runs (run_id),
  severity   text not null check (severity in ('FAILURE', 'DEGRADED', 'DRIFT', 'WARNING')),
  code       text not null,
  message    text not null,
  detail     jsonb,
  created_at timestamptz not null default now()
);
create index if not exists nhl_goalie_alerts_created_idx on public.nhl_goalie_alerts (created_at desc);

-- ---------------------------------------------------------------- starters (T0, with the T2 projection labelled)
create table if not exists public.nhl_goalie_starters (
  id                 bigserial primary key,
  game_id            text not null,
  game_start_utc     timestamptz not null,
  team               text not null,
  side               text not null check (side in ('home', 'away')),
  goalie_id          text,
  goalie_name        text,
  status             public.nhl_goalie_status not null,
  source             text not null check (source in ('daily_faceoff', 'nhl_api_boxscore', 'manual', 'edgedesk_projection', 'consensus')),
  source_status      text,
  source_url         text,
  source_updated_at  timestamptz,
  fetched_at         timestamptz not null,
  is_current         boolean not null default true,
  superseded_at      timestamptz,
  conflict           boolean not null default false,
  conflict_detail    jsonb,
  match_method       text check (match_method in ('id', 'team_exact', 'team_initial', 'league_exact', 'league_initial', 'ambiguous', 'unmatched', 'projection', 'none')),
  merged_from        jsonb,
  run_id             uuid,  -- the run that wrote it (no foreign key: the run row is written last, in its own request)
  created_at         timestamptz not null default now(),
  check (status <> 'confirmed' or goalie_name is not null),
  check (source = 'consensus' or not conflict),
  check (conflict = (conflict_detail is not null)),
  check (not conflict or status <> 'confirmed'),
  check (status = 'unknown' or goalie_name is not null),
  check (is_current = (superseded_at is null))
);
create index if not exists nhl_goalie_starters_game_idx on public.nhl_goalie_starters (game_id, team, source, fetched_at desc, id desc);
create unique index if not exists nhl_goalie_starters_one_current on public.nhl_goalie_starters (game_id, team, source) where is_current;

-- a new observation supersedes the current one for the same game, team and source
create or replace function public.nhl_goalie_starter_supersede()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $s$
declare cur record;
begin
  new.is_current := true; new.superseded_at := null;
  select * into cur from public.nhl_goalie_starters
   where game_id = new.game_id and team = new.team and source = new.source and is_current limit 1;
  if cur.id is not null then
    if new.fetched_at < cur.fetched_at then
      raise exception 'nhl_goalie_starters: an observation fetched at % is older than the current one (%) for % % %', new.fetched_at, cur.fetched_at, new.game_id, new.team, new.source;
    end if;
    perform set_config('edgedesk.nhl_goalie_supersede', 'on', true);
    update public.nhl_goalie_starters set is_current = false, superseded_at = new.fetched_at where id = cur.id;
    perform set_config('edgedesk.nhl_goalie_supersede', 'off', true);
  end if;
  return new;
end $s$;
drop trigger if exists nhl_goalie_starters_supersede on public.nhl_goalie_starters;
create trigger nhl_goalie_starters_supersede before insert on public.nhl_goalie_starters for each row execute function public.nhl_goalie_starter_supersede();

-- the only update ever allowed: the supersede above turning is_current off
create or replace function public.nhl_goalie_starter_guard()
returns trigger language plpgsql as $g$
begin
  if tg_op = 'UPDATE'
     and coalesce(current_setting('edgedesk.nhl_goalie_supersede', true), 'off') = 'on'
     and old.is_current and not new.is_current and new.superseded_at is not null
     and (to_jsonb(new) - 'is_current' - 'superseded_at') = (to_jsonb(old) - 'is_current' - 'superseded_at') then
    return new;
  end if;
  raise exception 'public.nhl_goalie_starters is append-only: % refused (an observation is superseded by inserting a new one)', tg_op;
end $g$;
drop trigger if exists nhl_goalie_starters_frozen on public.nhl_goalie_starters;
create trigger nhl_goalie_starters_frozen before update or delete on public.nhl_goalie_starters for each row execute function public.nhl_goalie_starter_guard();

-- ---------------------------------------------------------------- the game cards (versioned)
create table if not exists public.nhl_game_cards (
  id                   bigserial primary key,
  game_id              text not null,
  version              integer not null check (version >= 1),
  game_start_utc       timestamptz not null,
  home                 text not null,
  away                 text not null,
  generated_at         timestamptz not null,
  trigger              text not null check (trigger in ('initial', 'starter_changed', 'status_changed', 'conflict_changed', 'inputs_changed')),
  reasons              jsonb not null default '[]'::jsonb,
  supersedes_id        bigint references public.nhl_game_cards (id),
  goalie_pairing_used  jsonb not null,
  goalie_status_home   public.nhl_goalie_status not null,
  goalie_status_away   public.nhl_goalie_status not null,
  home_goalie_id       text,
  home_goalie_name     text,
  away_goalie_id       text,
  away_goalie_name     text,
  home_starter_row_id  bigint references public.nhl_goalie_starters (id),
  away_starter_row_id  bigint references public.nhl_goalie_starters (id),
  conflict             boolean not null default false,
  headline             jsonb not null,
  pairing_price        jsonb,
  pairing_range        jsonb not null,
  range                jsonb,
  show_range           boolean not null,
  edge_gate            jsonb not null,
  edge_gate_state      text not null check (edge_gate_state in ('OPEN', 'GATED')),
  known_limitations    jsonb not null default '[]'::jsonb,
  notes                jsonb not null default '[]'::jsonb,
  change_note          jsonb,
  model_id             text not null,
  goalie_variant       text not null,
  slate_generated_at   timestamptz,
  inputs_hash          text not null,
  core_version         text not null,
  run_id               uuid,  -- the run that wrote it (no foreign key: the run row is written last)
  created_at           timestamptz not null default now(),
  unique (game_id, version),
  check (generated_at < game_start_utc),
  check ((version = 1) = (supersedes_id is null)),
  check (jsonb_typeof(pairing_range) = 'array' and jsonb_array_length(pairing_range) >= 1),
  check (jsonb_typeof(known_limitations) = 'array'),
  -- both Confirmed and no conflict <=> the gate is OPEN; otherwise the range shows and the card says so
  check ((goalie_status_home = 'confirmed' and goalie_status_away = 'confirmed' and not conflict) = (edge_gate_state = 'OPEN')),
  check (edge_gate_state = 'OPEN' or (show_range and known_limitations ? 'Starter not confirmed. Numbers may change.'))
);
create index if not exists nhl_game_cards_game_idx on public.nhl_game_cards (game_id, version desc);

-- versions run 1, 2, 3 per game, each superseding the latest; only the live variant may price a live card
create or replace function public.nhl_game_card_version()
returns trigger language plpgsql as $v$
declare prev record; v_variant text; v_prefix text;
begin
  select value into v_variant from public.nhl_goalie_config where key = 'live_goalie_variant';
  select value into v_prefix from public.nhl_goalie_config where key = 'live_model_prefix';
  if new.goalie_variant is distinct from coalesce(v_variant, 'xg_goalie_confirmed') then
    raise exception 'nhl_game_cards: a live card must be priced by % (this one names %): the experimental goalie rating cannot reach a live card', coalesce(v_variant, 'xg_goalie_confirmed'), new.goalie_variant;
  end if;
  if position(coalesce(v_prefix, 'edgedesk_nhl_v1:') in new.model_id) <> 1 then
    raise exception 'nhl_game_cards: a live card names the production model (%...), not %', coalesce(v_prefix, 'edgedesk_nhl_v1:'), new.model_id;
  end if;
  select * into prev from public.nhl_game_cards where game_id = new.game_id order by version desc limit 1;
  if prev.id is null then
    if new.version <> 1 or new.supersedes_id is not null then raise exception 'nhl_game_cards: the first card for % is version 1 and supersedes nothing', new.game_id; end if;
  else
    if new.version <> prev.version + 1 or new.supersedes_id is distinct from prev.id then
      raise exception 'nhl_game_cards: the next card for % is version % superseding card % (got version % superseding %)', new.game_id, prev.version + 1, prev.id, new.version, new.supersedes_id;
    end if;
    if new.generated_at <= prev.generated_at then raise exception 'nhl_game_cards: version % must be generated after version %', new.version, prev.version; end if;
  end if;
  return new;
end $v$;
drop trigger if exists nhl_game_cards_version on public.nhl_game_cards;
create trigger nhl_game_cards_version before insert on public.nhl_game_cards for each row execute function public.nhl_game_card_version();

-- ---------------------------------------------------------------- edges, attached to the version that existed
create table if not exists public.nhl_card_edge_events (
  id                 bigserial primary key,
  card_id            bigint not null references public.nhl_game_cards (id),
  game_id            text not null,
  market             text not null check (market in ('moneyline', 'puck_line', 'total')),
  side               text not null check (side in ('home', 'away', 'over', 'under')),
  line               numeric,
  american           integer not null,
  book               text,
  quote_source       text,
  quote_captured_at  timestamptz,
  p_win              numeric not null,
  p_push             numeric not null default 0,
  ev                 numeric not null,
  min_ev             numeric not null,
  ev_min_pairings    numeric,
  ev_pairing_used    numeric,
  flag_allowed       boolean not null,
  gate_basis         text not null check (gate_basis in ('BOTH_CONFIRMED', 'HOLDS_EVERY_PAIRING', 'GATED')),
  gate_reason        text,
  detected_at        timestamptz not null,
  run_id             uuid,
  created_at         timestamptz not null default now(),
  check (ev >= min_ev),
  check ((gate_basis = 'GATED') = (not flag_allowed)),
  check (market = 'moneyline' or line is not null)
);
create unique index if not exists nhl_card_edge_events_once on public.nhl_card_edge_events (card_id, market, side, coalesce(line, -999), coalesce(quote_captured_at, '1970-01-01 00:00:00+00'::timestamptz), american);
create index if not exists nhl_card_edge_events_game_idx on public.nhl_card_edge_events (game_id, detected_at desc);

create or replace function public.nhl_card_edge_attach()
returns trigger language plpgsql as $a$
declare c record; newer record;
begin
  select * into c from public.nhl_game_cards where id = new.card_id;
  if c.id is null then raise exception 'nhl_card_edge_events: card % does not exist', new.card_id; end if;
  if c.game_id <> new.game_id then raise exception 'nhl_card_edge_events: card % is game %, not %', c.id, c.game_id, new.game_id; end if;
  if new.detected_at < c.generated_at then
    raise exception 'nhl_card_edge_events: card % (version %) was generated at %, after the edge was detected (%)', c.id, c.version, c.generated_at, new.detected_at;
  end if;
  select * into newer from public.nhl_game_cards
   where game_id = c.game_id and version > c.version and generated_at <= new.detected_at order by version desc limit 1;
  if newer.id is not null then
    raise exception 'nhl_card_edge_events: at % the current card was version % (card %), not version %: an edge attaches to the version that existed when it was detected', new.detected_at, newer.version, newer.id, c.version;
  end if;
  if new.detected_at >= c.game_start_utc then raise exception 'nhl_card_edge_events: detected at or after puck drop'; end if;
  if c.edge_gate_state = 'GATED' and new.gate_basis = 'BOTH_CONFIRMED' then
    raise exception 'nhl_card_edge_events: card version % is GATED (a starter is not Confirmed): BOTH_CONFIRMED is not its basis', c.version;
  end if;
  return new;
end $a$;
drop trigger if exists nhl_card_edge_events_attach on public.nhl_card_edge_events;
create trigger nhl_card_edge_events_attach before insert on public.nhl_card_edge_events for each row execute function public.nhl_card_edge_attach();

create table if not exists public.nhl_card_edge_clv (
  id                   bigserial primary key,
  edge_event_id        bigint not null unique references public.nhl_card_edge_events (id),
  closing_american     integer not null,
  closing_book         text,
  closing_captured_at  timestamptz not null,
  closing_p_novig      numeric,
  clv_pct              numeric not null,
  basis                text not null default 'decimal price taken / closing fair decimal - 1 (no-vig when both sides closed)',
  graded_at            timestamptz not null default now()
);
create or replace function public.nhl_card_edge_clv_check()
returns trigger language plpgsql as $c$
declare e record; c record;
begin
  select * into e from public.nhl_card_edge_events where id = new.edge_event_id;
  select * into c from public.nhl_game_cards where id = e.card_id;
  if new.closing_captured_at < e.detected_at or new.closing_captured_at >= c.game_start_utc then
    raise exception 'nhl_card_edge_clv: the close must be captured after the edge (%) and before puck drop (%)', e.detected_at, c.game_start_utc;
  end if;
  return new;
end $c$;
drop trigger if exists nhl_card_edge_clv_check on public.nhl_card_edge_clv;
create trigger nhl_card_edge_clv_check before insert on public.nhl_card_edge_clv for each row execute function public.nhl_card_edge_clv_check();

-- append-only, every table but the starters (guarded above)
do $t$ declare t text; begin
  foreach t in array array['nhl_goalie_sync_runs', 'nhl_goalie_alerts', 'nhl_game_cards', 'nhl_card_edge_events', 'nhl_card_edge_clv'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_frozen', t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.nhl_goalie_keep()', t || '_frozen', t);
  end loop;
  foreach t in array array['nhl_goalie_sync_runs', 'nhl_goalie_alerts', 'nhl_goalie_starters', 'nhl_game_cards', 'nhl_card_edge_events', 'nhl_card_edge_clv'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.nhl_goalie_keep()', t || '_no_truncate', t);
  end loop;
end $t$;

-- ---------------------------------------------------------------- views
create or replace view public.nhl_goalie_starters_current with (security_invoker = true) as
select s.* from public.nhl_goalie_starters s
 where s.is_current and s.game_start_utc > now() - interval '6 hours';

create or replace view public.nhl_game_cards_current with (security_invoker = true) as
select distinct on (game_id) *
  from public.nhl_game_cards
 where game_start_utc > now() - interval '6 hours'
 order by game_id, version desc;

create or replace view public.nhl_card_edge_clv_detail with (security_invoker = true) as
select e.id as edge_event_id, e.game_id, e.market, e.side, e.line, e.american, e.book, e.detected_at, e.p_win, e.ev, e.flag_allowed, e.gate_basis,
       c.id as card_id, c.version as card_version, c.generated_at as card_generated_at, c.goalie_pairing_used, c.goalie_status_home, c.goalie_status_away, c.edge_gate_state,
       v.closing_american, v.closing_book, v.closing_captured_at, v.closing_p_novig, v.clv_pct, v.graded_at
  from public.nhl_card_edge_events e
  join public.nhl_game_cards c on c.id = e.card_id
  left join public.nhl_card_edge_clv v on v.edge_event_id = e.id;

-- THE KPIs: confirmed by T-30, sync failures, source conflicts. One row.
create or replace view public.nhl_goalie_readiness with (security_invoker = true) as
with cfg as (
  select coalesce((select value::int from public.nhl_goalie_config where key = 't30_grace_minutes'), 5) as grace,
         coalesce((select value::numeric from public.nhl_goalie_config where key = 'confirmed_by_t30_target_pct'), 90) as target
), any_run as (select * from public.nhl_goalie_sync_runs order by finished_at desc limit 1),
   checked as (select * from public.nhl_goalie_sync_runs where status <> 'skipped' order by finished_at desc limit 1),
   good as (select * from public.nhl_goalie_sync_runs where status in ('ok', 'warn') order by finished_at desc limit 1),
   a24 as (select count(*) filter (where severity = 'FAILURE') as failures, count(*) filter (where severity = 'DEGRADED') as degraded,
                  count(*) filter (where severity = 'DRIFT') as drift, count(*) filter (where severity = 'WARNING') as warnings
             from public.nhl_goalie_alerts where created_at > now() - interval '24 hours'),
   r24 as (select count(*) as runs, count(*) filter (where status = 'error') as errors, count(*) filter (where status = 'skipped') as skipped,
                  count(*) filter (where status <> 'skipped' and daily_faceoff_ok is false) as df_down, count(*) filter (where status <> 'skipped' and nhl_api_ok is false) as nhl_down
             from public.nhl_goalie_sync_runs where finished_at > now() - interval '24 hours'),
   streak as (select count(*) as n from public.nhl_goalie_sync_runs
               where status = 'error' and finished_at > coalesce((select finished_at from good), '-infinity'::timestamptz)),
   g7 as (select distinct on (game_id) game_id, game_start_utc, home, away from public.nhl_game_cards
           where game_start_utc > now() - interval '7 days' and game_start_utc <= now() order by game_id, version desc),
   t30 as (
     select g.game_id,
            (select s.status from public.nhl_goalie_starters s where s.game_id = g.game_id and s.team = g.home and s.source = 'consensus'
                and s.fetched_at <= g.game_start_utc - make_interval(mins => 30 - (select grace from cfg)) order by s.fetched_at desc, s.id desc limit 1) as h_status,
            (select s.conflict from public.nhl_goalie_starters s where s.game_id = g.game_id and s.team = g.home and s.source = 'consensus'
                and s.fetched_at <= g.game_start_utc - make_interval(mins => 30 - (select grace from cfg)) order by s.fetched_at desc, s.id desc limit 1) as h_conflict,
            (select s.status from public.nhl_goalie_starters s where s.game_id = g.game_id and s.team = g.away and s.source = 'consensus'
                and s.fetched_at <= g.game_start_utc - make_interval(mins => 30 - (select grace from cfg)) order by s.fetched_at desc, s.id desc limit 1) as a_status,
            (select s.conflict from public.nhl_goalie_starters s where s.game_id = g.game_id and s.team = g.away and s.source = 'consensus'
                and s.fetched_at <= g.game_start_utc - make_interval(mins => 30 - (select grace from cfg)) order by s.fetched_at desc, s.id desc limit 1) as a_conflict
       from g7 g),
   t30s as (select count(*) as games, count(*) filter (where h_status = 'confirmed' and a_status = 'confirmed' and not coalesce(h_conflict, false) and not coalesce(a_conflict, false)) as confirmed,
                   count(*) filter (where h_status = 'confirmed' and not coalesce(h_conflict, false)) + count(*) filter (where a_status = 'confirmed' and not coalesce(a_conflict, false)) as sides_confirmed
              from t30),
   conf as (select count(*) filter (where s.is_current and s.game_start_utc > now()) as open_now,
                   count(distinct (s.game_id, s.team)) filter (where s.created_at > now() - interval '24 hours') as in_24h,
                   count(distinct (s.game_id, s.team)) filter (where s.created_at > now() - interval '7 days') as in_7d
              from public.nhl_goalie_starters s where s.source = 'consensus' and s.conflict),
   soon as (select count(*) as sides, count(*) filter (where s.status <> 'confirmed' or s.conflict) as unconfirmed
              from public.nhl_goalie_starters s where s.source = 'consensus' and s.is_current and s.game_start_utc > now() and s.game_start_utc <= now() + interval '3 hours'),
   cards as (select count(*) as games, count(*) filter (where edge_gate_state = 'GATED') as gated, coalesce(sum(version - 1), 0) as revisions
               from public.nhl_game_cards_current where game_start_utc > now())
select
  (select finished_at from any_run)                                          as last_run_at,
  (select status from any_run)                                               as last_run_status,
  (select finished_at from checked)                                          as last_check_at,
  (select status from checked)                                               as last_check_status,
  (select message from checked)                                              as last_check_message,
  (select finished_at from good)                                             as last_success_at,
  round(extract(epoch from now() - (select finished_at from good)) / 60)::int as minutes_since_success,
  (select next_due_at from checked)                                          as next_due_at,
  (select daily_faceoff_ok from checked)                                     as daily_faceoff_ok,
  (select nhl_api_ok from checked)                                           as nhl_api_ok,
  coalesce((select unmatched from good), 0)                                  as unmatched_names,
  (select n from streak)::int                                                as consecutive_failures,
  (select failures from a24)::int as failures_24h, (select degraded from a24)::int as degraded_24h,
  (select drift from a24)::int as drift_24h, (select warnings from a24)::int as warnings_24h,
  (select runs from r24)::int as runs_24h, (select errors from r24)::int as sync_failures_24h, (select skipped from r24)::int as skipped_24h,
  (select df_down from r24)::int as daily_faceoff_down_24h, (select nhl_down from r24)::int as nhl_api_down_24h,
  (select games from t30s)::int                                              as games_7d,
  (select confirmed from t30s)::int                                          as games_confirmed_by_t30_7d,
  case when (select games from t30s) > 0 then round(100.0 * (select confirmed from t30s) / (select games from t30s), 1) end as pct_confirmed_by_t30_7d,
  case when (select games from t30s) > 0 then round(100.0 * (select sides_confirmed from t30s) / (2 * (select games from t30s)), 1) end as pct_sides_confirmed_by_t30_7d,
  (select target from cfg)                                                   as confirmed_by_t30_target_pct,
  (select open_now from conf)::int                                           as conflicts_open,
  (select in_24h from conf)::int                                             as conflicts_24h,
  (select in_7d from conf)::int                                              as conflicts_7d,
  (select sides from soon)::int                                              as sides_next_3h,
  (select unconfirmed from soon)::int                                        as sides_unconfirmed_next_3h,
  (select games from cards)::int as cards_upcoming, (select gated from cards)::int as cards_gated, (select revisions from cards)::int as card_revisions_upcoming,
  case
    when (select finished_at from any_run) is null then 'error'
    when (select status from checked) = 'error' then 'error'
    when now() - (select finished_at from any_run) > interval '90 minutes' then 'error'
    when (select failures from a24) > 0 or (select degraded from a24) > 0 or (select drift from a24) > 0
      or (select open_now from conf) > 0
      or coalesce((select unmatched from good), 0) > 0
      or ((select games from t30s) >= 5 and 100.0 * (select confirmed from t30s) / (select games from t30s) < (select target from cfg)) then 'warn'
    else 'ok'
  end as state,
  case
    when (select finished_at from any_run) is null then 'the goalie sync has never run'
    when (select status from checked) = 'error' then 'the last check failed: ' || coalesce((select message from checked), 'no message')
    when now() - (select finished_at from any_run) > interval '90 minutes' then 'no run in over 90 minutes: the scheduler is not calling the sync'
    when (select drift from a24) > 0 then 'a source''s layout drifted (see nhl_goalie_alerts)'
    when (select open_now from conf) > 0 then (select open_now from conf) || ' open source conflict(s) on upcoming games'
    when ((select games from t30s) >= 5 and 100.0 * (select confirmed from t30s) / (select games from t30s) < (select target from cfg))
      then 'only ' || round(100.0 * (select confirmed from t30s) / (select games from t30s), 1) || '% of games had both starters Confirmed by T-30 (target ' || (select target from cfg) || '%)'
    else null
  end as state_reason
;

create or replace view public.nhl_goalie_meta with (security_invoker = true) as
select 'nhl_goalie_sync_last_run'::text as key, (select finished_at::text from public.nhl_goalie_sync_runs where status <> 'skipped' order by finished_at desc limit 1) as value
union all select 'nhl_goalie_sync_last_status', (select case status when 'error' then 'error' when 'warn' then 'warn' else 'ok' end from public.nhl_goalie_sync_runs where status <> 'skipped' order by finished_at desc limit 1)
union all select 'row_count_nhl_goalie_sync', (select observations_written::text from public.nhl_goalie_sync_runs where status in ('ok', 'warn') order by finished_at desc limit 1)
union all select 'nhl_game_card_last_version_at', (select max(generated_at)::text from public.nhl_game_cards);

-- ---------------------------------------------------------------- the card
-- What one NHL game card shows about its goalies, with the freshness rule in
-- one place. freshness:
--   FRESH     a check succeeded recently enough (30 minutes within three hours
--             of puck drop, 150 otherwise; 26 hours when only skipped runs followed)
--   STALE     no successful check recently enough: the card says when it last was
--   FAILED    the latest check failed
--   NO_RUN    the sync has never run
--   PREGAME   the game has started: the last version generated before puck drop
-- card: the latest version; first: version 1 (for "Updated: starter changed
-- from X to Y"); starters: every source's current row per side.
create or replace function public.nhl_goalie_card(p_game_id text)
returns jsonb language plpgsql stable security invoker set search_path = public as $c$
declare
  v_last record; v_good record; v_card record; v_first record; n int; fresh text; why text; maxage int; started boolean; starters jsonb;
  max_reg int := coalesce((select value::int from public.nhl_goalie_config where key = 'check_max_age_minutes'), 150);
  max_pre int := coalesce((select value::int from public.nhl_goalie_config where key = 'pregame_check_max_age_minutes'), 30);
begin
  select x.* into v_card from public.nhl_game_cards x where false;
  select x.* into v_first from public.nhl_game_cards x where false;
  select * into v_last from public.nhl_goalie_sync_runs where status <> 'skipped' order by finished_at desc limit 1;
  select * into v_good from public.nhl_goalie_sync_runs where status in ('ok', 'warn') order by finished_at desc limit 1;
  select x.* into v_card from public.nhl_game_cards x where x.game_id = p_game_id order by x.version desc limit 1;
  select x.* into v_first from public.nhl_game_cards x where x.game_id = p_game_id and x.version = 1;
  select count(*) into n from public.nhl_game_cards x where x.game_id = p_game_id;
  started := v_card.id is not null and v_card.game_start_utc <= now();
  if started then fresh := 'PREGAME';
  elsif v_last.run_id is null then fresh := 'NO_RUN'; why := 'the goalie sync has not run yet';
  elsif v_last.status = 'error' then fresh := 'FAILED'; why := 'the latest check failed: ' || coalesce(v_last.message, 'no message');
  else
    maxage := case when v_card.id is not null and v_card.game_start_utc - now() <= interval '3 hours' then max_pre else max_reg end;
    if v_good.run_id is null or now() - v_good.finished_at > make_interval(mins => maxage) then
      fresh := 'STALE'; why := 'starters last checked ' || coalesce(to_char(v_good.finished_at at time zone 'America/New_York', 'Mon DD HH12:MI AM') || ' ET', 'never');
    else fresh := 'FRESH';
    end if;
  end if;
  select coalesce(jsonb_object_agg(side, rows), '{}'::jsonb) into starters from (
    select s.side, jsonb_agg(jsonb_build_object('id', s.id, 'source', s.source, 'goalie_id', s.goalie_id, 'goalie_name', s.goalie_name, 'status', s.status,
             'source_status', s.source_status, 'source_url', s.source_url, 'source_updated_at', s.source_updated_at, 'fetched_at', s.fetched_at,
             'conflict', s.conflict, 'conflict_detail', s.conflict_detail, 'match_method', s.match_method) order by s.source) as rows
      from public.nhl_goalie_starters s where s.game_id = p_game_id and s.is_current group by s.side) t;
  return jsonb_build_object(
    'game_id', p_game_id, 'state', case when v_card.id is null then 'NO_CARD' else 'CARD' end, 'freshness', fresh, 'reason', why, 'now', now(),
    'last_check_at', v_last.finished_at, 'last_check_status', v_last.status, 'last_success_at', v_good.finished_at, 'versions', n,
    'card', case when v_card.id is null then null else to_jsonb(v_card) end,
    'first', case when v_first.id is null then null else jsonb_build_object('id', v_first.id, 'version', v_first.version, 'generated_at', v_first.generated_at, 'goalie_pairing_used', v_first.goalie_pairing_used,
                    'goalie_status_home', v_first.goalie_status_home, 'goalie_status_away', v_first.goalie_status_away, 'pairing_price', v_first.pairing_price) end,
    'starters', starters);
end $c$;

-- ---------------------------------------------------------------- access
do $p$ declare t text; begin
  foreach t in array array['nhl_goalie_config', 'nhl_goalie_sync_runs', 'nhl_goalie_alerts', 'nhl_goalie_starters', 'nhl_game_cards', 'nhl_card_edge_events', 'nhl_card_edge_clv'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to anon, authenticated using (true)', t || '_read', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to anon, authenticated', t);
  end loop;
end $p$;
grant select on public.nhl_goalie_starters_current, public.nhl_game_cards_current, public.nhl_card_edge_clv_detail, public.nhl_goalie_readiness, public.nhl_goalie_meta to anon, authenticated;
revoke all on function public.nhl_goalie_card(text) from public;
grant execute on function public.nhl_goalie_card(text) to anon, authenticated;
revoke all on function public.nhl_goalie_keep() from public, anon, authenticated;
revoke all on function public.nhl_goalie_starter_supersede() from public, anon, authenticated;
revoke all on function public.nhl_goalie_starter_guard() from public, anon, authenticated;
revoke all on function public.nhl_game_card_version() from public, anon, authenticated;
revoke all on function public.nhl_card_edge_attach() from public, anon, authenticated;
revoke all on function public.nhl_card_edge_clv_check() from public, anon, authenticated;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert on public.nhl_goalie_sync_runs, public.nhl_goalie_alerts, public.nhl_goalie_starters, public.nhl_game_cards, public.nhl_card_edge_events, public.nhl_card_edge_clv to service_role';
    execute 'grant select on public.nhl_goalie_config to service_role';
    execute 'grant select on public.nhl_goalie_starters_current, public.nhl_game_cards_current, public.nhl_card_edge_clv_detail, public.nhl_goalie_readiness, public.nhl_goalie_meta to service_role';
    execute 'grant usage, select on all sequences in schema public to service_role';
    execute 'grant execute on function public.nhl_goalie_card(text) to service_role';
  end if;
end $g$;

commit;

notify pgrst, 'reload schema';

-- THE REPORT. Every row should say ok.
select piece, state from (
  select '1 six append-only tables' as piece,
         case when (select count(*) from pg_trigger where tgname like 'nhl\_%\_no\_truncate' escape '\' and not tgisinternal) >= 6
               and (select count(*) from pg_trigger where tgname like 'nhl\_%\_frozen' escape '\' and not tgisinternal) >= 6 then 'ok' else 'CHECK THIS' end as state
  union all select '2 row level security on every table',
         case when (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relname in ('nhl_goalie_config', 'nhl_goalie_sync_runs', 'nhl_goalie_alerts', 'nhl_goalie_starters',
              'nhl_game_cards', 'nhl_card_edge_events', 'nhl_card_edge_clv') and relrowsecurity) = 7 then 'ok' else 'CHECK THIS' end
  union all select '3 no client write policy',
         case when not exists (select 1 from pg_policies where schemaname = 'public' and tablename like 'nhl\_goalie%' escape '\' and cmd <> 'SELECT')
               and not exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('nhl_game_cards', 'nhl_card_edge_events', 'nhl_card_edge_clv') and cmd <> 'SELECT') then 'ok' else 'CHECK THIS' end
  union all select '4 one current observation per game, team and source',
         case when to_regclass('public.nhl_goalie_starters_one_current') is not null then 'ok' else 'CHECK THIS' end
  union all select '5 card versions and edge attachment are enforced',
         case when exists (select 1 from pg_trigger where tgname = 'nhl_game_cards_version') and exists (select 1 from pg_trigger where tgname = 'nhl_card_edge_events_attach') then 'ok' else 'CHECK THIS' end
  union all select '6 the readiness view answers', case when (select count(*) from public.nhl_goalie_readiness) = 1 then 'ok' else 'CHECK THIS' end
) r order by 1;
