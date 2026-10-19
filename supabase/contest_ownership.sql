-- =============================================================================
-- contest_ownership.sql — what share of a public contest's entries took each
-- side (Circa Sports Million). T0: observed, from the contest's own published
-- selections PDF. docs/market-structure/README.md §Contest ownership
--
-- WHAT IT ADDS (additive only)
--   contest_ownership_config      the contest per season: edition, Week 1's
--                                 Thursday, on/off
--   contest_ownership_runs        append-only: every fetch, its outcome
--                                 (complete / partial / failed), the entries the
--                                 document stated and the entries read, picks
--                                 parsed / placed / quarantined, the source URL
--                                 and its sha256
--   contest_ownership             append-only: one row per side per run — the
--                                 contest line, picks, share of cards, share of
--                                 that game's picks, the Odds API event and the
--                                 canonical game
--   contest_ownership_quarantine  append-only: every pick that did not resolve to
--                                 a club or a game, and every row that did not
--                                 read as five picks — kept with its own text
--   contest_ownership_ingest(run, sides, quarantine)
--                                 the one writer (circa_ownership_sync, service
--                                 role): refuses a run whose picks do not add up
--   contest_ownership_fail(...)   records a failed fetch and raises the alert
--   contest_ownership_latest      the card's read: the latest complete or partial
--                                 run per contest week, labelled with its status;
--                                 a failed run is never shown, and nothing from an
--                                 earlier week stands in for this one
--
-- WHAT IT DOES NOT DO
--   Ownership is weighted by ENTRY (cards), not by unique player: one person
--   with three entries counts three times. Nothing here feeds a projection,
--   spread, probability, EV, ranking or grade.
--
-- REQUIRES supabase/nfl_market_structure.sql (market_structure_alerts,
-- nfl_canonical_game_id). CONVENTION (supabase/README.md): idempotent,
-- additive, pasted into the SQL editor, no psql meta-commands, ends in a report.
-- =============================================================================

do $req$ begin
  if to_regprocedure('public.market_structure_alert(text,text,text,text,jsonb)') is null then
    raise exception 'apply supabase/nfl_market_structure.sql first: contest_ownership.sql writes its alerts there';
  end if;
end $req$;

begin;

create table if not exists public.contest_ownership_config (
  contest          text not null,
  season           integer not null,
  edition          text not null,
  week1_thursday   date not null,
  enabled          boolean not null default true,
  note             text,
  primary key (contest, season)
);
insert into public.contest_ownership_config (contest, season, edition, week1_thursday, note)
values ('circa_million', 2026, 'VIII', '2026-09-10',
        'Circa Sports Million VIII. Selections are published as a PDF on circasports.com, usually the Saturday before the Sunday games.')
on conflict (contest, season) do nothing;

create table if not exists public.contest_ownership_runs (
  run_id            uuid primary key,
  contest           text not null,
  season            integer not null,
  week              integer not null check (week between 1 and 22),
  status            text not null check (status in ('complete', 'partial', 'failed')),
  code              text,
  message           text,
  entries_stated    integer,
  entries_parsed    integer,
  rows_unread       integer,
  picks_parsed      integer,
  picks_resolved    integer,
  picks_quarantined integer,
  source_url        text,
  source_sha256     text,
  parser_version    text,
  fetched_at        timestamptz not null,
  recorded_at       timestamptz not null default now(),
  constraint contest_ownership_runs_counted check (status = 'failed'
    or (entries_parsed > 0 and picks_parsed = entries_parsed * 5 and picks_resolved + picks_quarantined = picks_parsed
        and (entries_stated is null or entries_stated = entries_parsed + coalesce(rows_unread, 0)))),
  constraint contest_ownership_runs_complete check (status <> 'complete' or (picks_quarantined = 0 and coalesce(rows_unread, 0) = 0))
);
create index if not exists contest_ownership_runs_week_idx on public.contest_ownership_runs (contest, season, week, fetched_at desc);

create table if not exists public.contest_ownership (
  id                bigserial primary key,
  run_id            uuid not null references public.contest_ownership_runs (run_id),
  contest           text not null,
  season            integer not null,
  week              integer not null,
  event_id          text not null,
  canonical_game_id text,
  side_team_code    text not null,
  contest_game_no   integer,
  contest_line      numeric not null,
  picks             integer not null check (picks > 0),
  entries           integer not null check (entries > 0),
  game_picks        integer not null,
  share_of_cards    numeric not null check (share_of_cards >= 0 and share_of_cards <= 1),
  share_of_game     numeric not null check (share_of_game >= 0 and share_of_game <= 1),
  spellings         text[],
  fetched_at        timestamptz not null,
  source_url        text not null,
  unique (run_id, side_team_code)
);
create index if not exists contest_ownership_week_idx on public.contest_ownership (contest, season, week);

create table if not exists public.contest_ownership_quarantine (
  id              bigserial primary key,
  run_id          uuid not null references public.contest_ownership_runs (run_id),
  contest         text not null,
  season          integer not null,
  week            integer not null,
  row_no          integer,
  contest_game_no integer,
  team_raw        text,
  line_raw        text,
  picks           integer not null default 1 check (picks > 0),
  reason          text not null,
  detail          jsonb,
  fetched_at      timestamptz not null,
  source_url      text
);
create index if not exists contest_ownership_quarantine_run_idx on public.contest_ownership_quarantine (run_id);

do $t$ declare t text; begin
  foreach t in array array['contest_ownership_runs', 'contest_ownership', 'contest_ownership_quarantine'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_frozen', t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.market_structure_keep()', t || '_frozen', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.market_structure_keep()', t || '_no_truncate', t);
  end loop;
end $t$;

-- The one writer. Everything in one transaction: the run, its sides, its
-- quarantine. The arithmetic is checked here as well as in the function: picks
-- placed + picks quarantined = picks parsed = five per entry, and the sides of
-- each game add up to that game's picks.
create or replace function public.contest_ownership_ingest(p_run jsonb, p_sides jsonb, p_quarantine jsonb)
returns jsonb language plpgsql security definer set search_path = public as $i$
declare r public.contest_ownership_runs; placed int; held int; unread int; bad int;
begin
  r := jsonb_populate_record(null::public.contest_ownership_runs, p_run);
  r.recorded_at := now();
  if r.run_id is null or r.contest is null or r.season is null or r.week is null or r.fetched_at is null then
    raise exception 'contest_ownership_ingest: the run needs run_id, contest, season, week and fetched_at';
  end if;
  if r.status = 'failed' then raise exception 'contest_ownership_ingest: a failed run is recorded through contest_ownership_fail()'; end if;
  select coalesce(sum((x ->> 'picks')::int), 0) into placed from jsonb_array_elements(coalesce(p_sides, '[]'::jsonb)) x;
  -- a pick that read but did not place, and a ROW that did not read as five
  -- picks at all (reason unread_row), are both quarantined; only the first is
  -- inside the five-per-entry arithmetic
  select coalesce(sum(coalesce((x ->> 'picks')::int, 1)) filter (where x ->> 'reason' <> 'unread_row'), 0),
         count(*) filter (where x ->> 'reason' = 'unread_row')
    into held, unread from jsonb_array_elements(coalesce(p_quarantine, '[]'::jsonb)) x;
  if placed <> r.picks_resolved or held <> r.picks_quarantined or unread <> coalesce(r.rows_unread, 0) then
    raise exception 'contest_ownership_ingest: the rows do not add up to the run (placed % vs %, quarantined % vs %, unread rows % vs %)',
      placed, r.picks_resolved, held, r.picks_quarantined, unread, coalesce(r.rows_unread, 0);
  end if;
  select count(*) into bad from (
    select x ->> 'event_id' as e, sum((x ->> 'picks')::int) as s, max((x ->> 'game_picks')::int) as g
      from jsonb_array_elements(coalesce(p_sides, '[]'::jsonb)) x group by 1) z where z.s <> z.g;
  if bad > 0 then raise exception 'contest_ownership_ingest: % game(s) whose sides do not add up to the game''s picks', bad; end if;
  insert into public.contest_ownership_runs values (r.*);
  insert into public.contest_ownership (run_id, contest, season, week, event_id, canonical_game_id, side_team_code, contest_game_no, contest_line,
    picks, entries, game_picks, share_of_cards, share_of_game, spellings, fetched_at, source_url)
  select r.run_id, r.contest, r.season, r.week, x ->> 'event_id', public.nfl_canonical_game_id(x ->> 'event_id'), x ->> 'team_code',
         (x ->> 'contest_game_no')::int, (x ->> 'contest_line')::numeric, (x ->> 'picks')::int, r.entries_parsed, (x ->> 'game_picks')::int,
         round((x ->> 'picks')::numeric / r.entries_parsed, 6), round((x ->> 'picks')::numeric / nullif((x ->> 'game_picks')::int, 0), 6),
         array(select jsonb_array_elements_text(coalesce(x -> 'spellings', '[]'::jsonb))), r.fetched_at, r.source_url
    from jsonb_array_elements(coalesce(p_sides, '[]'::jsonb)) x;
  insert into public.contest_ownership_quarantine (run_id, contest, season, week, row_no, contest_game_no, team_raw, line_raw, picks, reason, detail, fetched_at, source_url)
  select r.run_id, r.contest, r.season, r.week, (x ->> 'row')::int, (x ->> 'contest_game_no')::int, x ->> 'team_raw', x ->> 'line_raw',
         coalesce((x ->> 'picks')::int, 1), coalesce(x ->> 'reason', 'unknown'), x -> 'detail', r.fetched_at, r.source_url
    from jsonb_array_elements(coalesce(p_quarantine, '[]'::jsonb)) x;
  if r.status = 'partial' then
    perform public.market_structure_alert('circa_ownership', 'WARNING', 'partial',
      'Week ' || r.week || ' ownership published as PARTIAL: ' || coalesce(r.picks_quarantined, 0) || ' pick(s) quarantined, ' || coalesce(r.rows_unread, 0) || ' row(s) unread',
      jsonb_build_object('run_id', r.run_id, 'source_url', r.source_url));
  end if;
  return jsonb_build_object('run_id', r.run_id, 'status', r.status, 'sides', jsonb_array_length(coalesce(p_sides, '[]'::jsonb)), 'quarantined_picks', held, 'unread_rows', unread);
end $i$;

-- A failed fetch. Before Sunday 13:00 Eastern of that contest week a missing
-- PDF is expected (Circa posts on Saturday) and is a WARNING; after it, or for
-- any other reason, it is a FAILURE.
create or replace function public.contest_ownership_fail(p_contest text, p_season integer, p_week integer, p_code text, p_message text,
  p_source_url text default null, p_detail jsonb default null, p_parsed jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $f$
declare c public.contest_ownership_config; sunday timestamptz; sev text; id uuid := gen_random_uuid();
begin
  select * into c from public.contest_ownership_config where contest = p_contest and season = p_season;
  if found then sunday := ((c.week1_thursday + (p_week - 1) * 7 + 3)::timestamp + time '13:00') at time zone 'America/New_York'; end if;
  sev := case when p_code = 'pdf_not_found' and sunday is not null and now() < sunday then 'WARNING' else 'FAILURE' end;
  insert into public.contest_ownership_runs (run_id, contest, season, week, status, code, message, entries_stated, entries_parsed, rows_unread,
    picks_parsed, source_url, parser_version, fetched_at)
  values (id, p_contest, p_season, p_week, 'failed', p_code, p_message, (p_parsed ->> 'entries_stated')::int, (p_parsed ->> 'entries_parsed')::int,
    (p_parsed ->> 'rows_unread')::int, (p_parsed ->> 'picks_parsed')::int, p_source_url, p_parsed ->> 'parser_version', now());
  perform public.market_structure_alert('circa_ownership', sev, p_code, 'Week ' || p_week || ': ' || p_message || ' — nothing published for this week',
    coalesce(p_detail, '{}'::jsonb) || jsonb_build_object('run_id', id, 'source_url', p_source_url));
  return jsonb_build_object('run_id', id, 'severity', sev);
end $f$;

create or replace view public.contest_ownership_latest as
  with last_good as (
    select distinct on (contest, season, week) * from public.contest_ownership_runs
     where status in ('complete', 'partial') order by contest, season, week, fetched_at desc)
  select o.contest, o.season, o.week, o.event_id, o.canonical_game_id, o.side_team_code, o.contest_game_no, o.contest_line,
         o.picks, o.entries, o.game_picks, o.share_of_cards, o.share_of_game, o.fetched_at, o.source_url,
         g.status as run_status, g.picks_quarantined, g.rows_unread, g.entries_stated, g.run_id
    from last_good g join public.contest_ownership o on o.run_id = g.run_id;

create or replace view public.contest_ownership_status as
  select distinct on (contest, season, week) contest, season, week, status, code, message, entries_stated, entries_parsed, picks_quarantined, rows_unread,
         source_url, fetched_at
    from public.contest_ownership_runs order by contest, season, week, fetched_at desc;

alter table public.contest_ownership_config enable row level security;
alter table public.contest_ownership_runs enable row level security;
alter table public.contest_ownership enable row level security;
alter table public.contest_ownership_quarantine enable row level security;
do $p$ declare t text; begin
  foreach t in array array['contest_ownership_config', 'contest_ownership_runs', 'contest_ownership', 'contest_ownership_quarantine'] loop
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to anon, authenticated using (true)', t || '_read', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to anon, authenticated', t);
  end loop;
end $p$;
grant select on public.contest_ownership_latest, public.contest_ownership_status to anon, authenticated;
revoke all on function public.contest_ownership_ingest(jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.contest_ownership_fail(text, integer, integer, text, text, text, jsonb, jsonb) from public, anon, authenticated;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.contest_ownership_ingest(jsonb, jsonb, jsonb) to service_role';
    execute 'grant execute on function public.contest_ownership_fail(text, integer, integer, text, text, text, jsonb, jsonb) to service_role';
    execute 'grant select on public.contest_ownership_config, public.contest_ownership_runs, public.contest_ownership, public.contest_ownership_quarantine to service_role';
    execute 'grant select on public.contest_ownership_latest, public.contest_ownership_status to service_role';
  end if;
end $g$;

commit;

notify pgrst, 'reload schema';

-- THE REPORT. Every row should say ok.
select piece, state from (
  select '1 config: Circa Million VIII, 2026' as piece, case when exists (select 1 from public.contest_ownership_config where contest = 'circa_million' and season = 2026) then 'ok' else 'CHECK THIS' end as state
  union all select '2 runs, sides and quarantine are append-only', case when (select count(*) from pg_trigger where tgname in ('contest_ownership_runs_frozen', 'contest_ownership_frozen', 'contest_ownership_quarantine_frozen')) = 3 then 'ok' else 'CHECK THIS' end
  union all select '3 a run that does not add up is refused by the table', case when exists (select 1 from pg_constraint where conname = 'contest_ownership_runs_counted') then 'ok' else 'CHECK THIS' end
  union all select '4 a run with anything quarantined can never read complete', case when exists (select 1 from pg_constraint where conname = 'contest_ownership_runs_complete') then 'ok' else 'CHECK THIS' end
  union all select '5 readers read; only the sync writes', case when has_table_privilege('anon', 'public.contest_ownership', 'select') and not has_table_privilege('anon', 'public.contest_ownership', 'insert')
    and not has_function_privilege('anon', 'public.contest_ownership_ingest(jsonb,jsonb,jsonb)', 'execute') then 'ok' else 'CHECK THIS' end
) r order by split_part(piece, ' ', 1)::int;
