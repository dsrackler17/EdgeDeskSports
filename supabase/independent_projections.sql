-- =============================================================================
-- independent_projections.sql — the multi-sport research desk's two ledgers:
-- the FROZEN independent projections and the market comparisons made against
-- them, in that order, enforced by the server.
--
-- WHY
--   EdgeDesk's models produce their own probabilities and fair lines before a
--   sportsbook price is consulted (lib/edgedesk_projections.js → EDPROJ). The
--   quant desk freezes those projections (a SHA-256 per projection and per
--   snapshot), writes the snapshot here, and only then reads prices and
--   compares (lib/edgedesk_market_compare.js → EDMKT). This file makes the
--   order a database fact rather than a promise:
--     projection_snapshots   one write-once row per research turn: every
--                            projection's id, hash, model, headline
--                            probabilities and fair lines, and the time it was
--                            frozen. A projection carrying ANY market input is
--                            refused: the snapshot is independent or it is
--                            not stored.
--     market_comparisons     one write-once row per market compared. Refused
--                            unless the same reader stored, EARLIER, the
--                            snapshot it names, with the same frozen time and
--                            a projection with the same id AND hash — so a
--                            comparison can never be written against a number
--                            that was produced after, or changed by, the
--                            price. A VERIFIED POSITIVE EV row also needs a
--                            live, timestamped sportsbook quote.
--   NOT added: the projections themselves already live in the engines'
--   published artifacts (hockey/slate.json, nba/slate.json, …) and in
--   engine/projections.json; these ledgers record what a turn froze and what
--   it compared.
--
-- THE RULES, ENFORCED BY THE SERVER
--   1. Write-once. No reader updates or deletes; retention runs through
--      independent_projections_prune() (service role only, at least 90 days).
--   2. Row level security: a reader inserts and reads only their own rows.
--      `authenticated` holds SELECT and INSERT only (Supabase's default ALL is
--      revoked, because TRUNCATE would bypass the row triggers).
--   3. Units: probabilities in [0, 1]; American odds at least 100 in size.
--   4. The server's clock: created_at is stamped by the database, a snapshot's
--      frozen_at must be within 30 minutes before the write (5 after), and a
--      comparison's compared_at within 30 minutes of its write; a comparison
--      names its projection's own sport and event, and a moneyline/1X2 row its
--      frozen probability. Nothing can be back-dated to look "frozen first".
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- Reversible: supabase/independent_projections_rollback.sql.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. PROJECTION SNAPSHOTS — frozen before any price is read
-- ---------------------------------------------------------------------------
create table if not exists public.projection_snapshots (
  id                 bigint generated always as identity primary key,
  snapshot_id        text not null check (snapshot_id ~ '^pjs_[0-9a-f]{32}$'),
  user_id            uuid default auth.uid(),
  created_at         timestamptz not null default now(),
  snapshot_hash      text not null check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  frozen_at          timestamptz not null,
  window_from        timestamptz,
  window_to          timestamptz,
  timezone           text check (timezone is null or length(timezone) <= 64),
  question           text check (question is null or length(question) <= 400),
  contract_version   text not null,
  projections_count  int not null check (projections_count between 0 and 2000),
  projections        jsonb not null check (jsonb_typeof(projections) = 'array'),
  constraint projection_snapshots_count_matches check (jsonb_array_length(projections) = projections_count),
  constraint projection_snapshots_not_future check (frozen_at <= created_at + interval '5 minutes'),
  constraint projection_snapshots_window check (window_from is null or window_to is null or window_from < window_to)
);
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'projection_snapshots_user_snapshot_key') then
    alter table public.projection_snapshots add constraint projection_snapshots_user_snapshot_key unique (user_id, snapshot_id);
  end if;
end $c$;
create index if not exists projection_snapshots_user_frozen_idx on public.projection_snapshots (user_id, frozen_at desc);

/* Every projection in a snapshot: an id, a 64-hex hash, probabilities in [0, 1] summing to at most 1,
   and NO market input. A market-informed number is not stored as an independent projection. */
create or replace function public.projection_snapshots_check()
returns trigger language plpgsql as $$
declare e jsonb; ph numeric; pa numeric; pd numeric;
begin
  /* the server's clock, not the writer's: the row is stamped now, and the freeze it records must be recent —
     a snapshot is written when it is frozen, so it cannot be back-dated to sit "before" an old price */
  new.created_at := now();
  if new.frozen_at < now() - interval '30 minutes' then
    raise exception 'projection_snapshots: frozen_at % is more than 30 minutes before the write (server clock %); a snapshot is stored when it is frozen, never back-dated', new.frozen_at, now() using errcode = 'check_violation';
  end if;
  for e in select * from jsonb_array_elements(new.projections) loop
    if coalesce(e->>'projection_id', '') !~ '^pj_[0-9a-f]{24}$' then
      raise exception 'projection_snapshots: a projection needs an id pj_<24 hex> (got %)', coalesce(e->>'projection_id', 'none') using errcode = 'check_violation';
    end if;
    if coalesce(e->>'projection_hash', '') !~ '^[0-9a-f]{64}$' then
      raise exception 'projection_snapshots: projection % has no SHA-256 hash', e->>'projection_id' using errcode = 'check_violation';
    end if;
    if jsonb_typeof(e->'market_inputs') is distinct from 'array' or jsonb_array_length(e->'market_inputs') <> 0 then
      raise exception 'projection_snapshots: projection % carries market inputs; only independent projections are stored', e->>'projection_id' using errcode = 'check_violation';
    end if;
    ph := nullif(e->>'p_home', '')::numeric; pa := nullif(e->>'p_away', '')::numeric; pd := nullif(e->>'p_draw', '')::numeric;
    if (ph is not null and (ph < 0 or ph > 1)) or (pa is not null and (pa < 0 or pa > 1)) or (pd is not null and (pd < 0 or pd > 1)) then
      raise exception 'projection_snapshots: projection % has a probability outside [0, 1] (a percent passed as a probability?)', e->>'projection_id' using errcode = 'check_violation';
    end if;
    if coalesce(ph, 0) + coalesce(pa, 0) + coalesce(pd, 0) > 1.0005 then
      raise exception 'projection_snapshots: projection % probabilities sum past 1', e->>'projection_id' using errcode = 'check_violation';
    end if;
  end loop;
  return new;
end $$;
drop trigger if exists projection_snapshots_check_trg on public.projection_snapshots;
create trigger projection_snapshots_check_trg before insert on public.projection_snapshots for each row execute function public.projection_snapshots_check();

-- ---------------------------------------------------------------------------
-- 2. MARKET COMPARISONS — only against a snapshot frozen earlier
-- ---------------------------------------------------------------------------
create table if not exists public.market_comparisons (
  id                         bigint generated always as identity primary key,
  comparison_id              text not null check (comparison_id ~ '^mc_[0-9a-f]{16}$'),
  user_id                    uuid default auth.uid(),
  created_at                 timestamptz not null default now(),
  snapshot_id                text not null,
  projection_id              text not null,
  projection_hash            text not null check (projection_hash ~ '^[0-9a-f]{64}$'),
  frozen_at                  timestamptz not null,
  compared_at                timestamptz not null,
  sport                      text not null,
  event_id                   text not null,
  market                     text not null check (market in ('moneyline','spread','total','three_way')),
  side                       text not null check (side in ('home','away','draw','over','under')),
  line                       numeric,
  model_probability          numeric check (model_probability is null or (model_probability >= 0 and model_probability <= 1)),
  model_push                 numeric check (model_push is null or (model_push >= 0 and model_push <= 1)),
  model_fair_american        int check (model_fair_american is null or abs(model_fair_american) >= 100),
  quote_kind                 text check (quote_kind is null or quote_kind in ('LIVE_SPORTSBOOK_QUOTE','CAPTURED_SPORTSBOOK_QUOTE','SHARP_MARKET_REFERENCE','CONSENSUS_REFERENCE','HISTORICAL_CLOSING_PRICE')),
  book                       text,
  odds_american              int check (odds_american is null or abs(odds_american) >= 100),
  quote_captured_at          timestamptz,
  quote_source               text,
  break_even                 numeric check (break_even is null or (break_even >= 0 and break_even <= 1)),
  ev_per_dollar              numeric,
  conservative_ev_per_dollar numeric,
  max_acceptable_american    int check (max_acceptable_american is null or abs(max_acceptable_american) >= 100),
  outcome                    text not null check (outcome in ('VERIFIED_POSITIVE_EV','CONDITIONAL_EDGE','MARKET_WATCH','NO_VERIFIED_EDGE','STALE_PRICE','NO_CURRENT_ODDS','INSUFFICIENT_MODEL_RELIABILITY')),
  reasons                    jsonb not null default '[]'::jsonb check (jsonb_typeof(reasons) = 'array'),
  gates                      jsonb not null default '[]'::jsonb check (jsonb_typeof(gates) = 'array'),
  engine_version             text,
  /* the projection is frozen first: a comparison stamped before the freeze is refused */
  constraint market_comparisons_frozen_first check (compared_at >= frozen_at),
  /* a verified edge stands on a live, timestamped book quote with a price, never on a reference or a stored capture */
  constraint market_comparisons_verified_needs_live_quote check (outcome <> 'VERIFIED_POSITIVE_EV' or (quote_kind = 'LIVE_SPORTSBOOK_QUOTE' and odds_american is not null and quote_captured_at is not null and quote_captured_at <= compared_at)),
  /* a stale or missing price never carries an EV verdict */
  constraint market_comparisons_no_ev_without_price check (outcome not in ('NO_CURRENT_ODDS') or ev_per_dollar is null)
);
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'market_comparisons_user_comparison_key') then
    alter table public.market_comparisons add constraint market_comparisons_user_comparison_key unique (user_id, comparison_id);
  end if;
end $c$;
create index if not exists market_comparisons_user_snapshot_idx on public.market_comparisons (user_id, snapshot_id);

/* The order, enforced: the same reader's snapshot exists, was frozen at the stated time (no later than
   the comparison) and holds this projection with this exact hash, for this sport and event, with this
   probability. The comparison is stamped with the server's clock and must be made now (within minutes),
   so it cannot be back-dated onto an old freeze. Runs as the definer so it can see the snapshot row under
   RLS, and checks user_id explicitly so no reader can borrow another's snapshot. */
create or replace function public.market_comparisons_frozen_check()
returns trigger language plpgsql security definer set search_path = public as $$
declare e jsonb; ps numeric;
begin
  new.created_at := now();
  if new.compared_at < now() - interval '30 minutes' or new.compared_at > now() + interval '5 minutes' then
    raise exception 'market_comparisons: compared_at % is not the time of the write (server clock %); a comparison is stored when it is made', new.compared_at, now() using errcode = 'check_violation';
  end if;
  select x.value into e
    from public.projection_snapshots s cross join lateral jsonb_array_elements(s.projections) x
   where s.user_id is not distinct from new.user_id
     and s.snapshot_id = new.snapshot_id
     and s.frozen_at = new.frozen_at
     and s.frozen_at <= new.compared_at
     and x.value->>'projection_id' = new.projection_id and x.value->>'projection_hash' = new.projection_hash
   limit 1;
  if e is null then
    raise exception 'market_comparisons: no snapshot % frozen at % holds projection % with hash %; a price may only be compared with a projection stored before it',
      new.snapshot_id, new.frozen_at, new.projection_id, left(new.projection_hash, 12) using errcode = 'foreign_key_violation';
  end if;
  if coalesce(e->>'sport', '') <> new.sport or coalesce(e->>'event_id', '') <> new.event_id then
    raise exception 'market_comparisons: projection % is % event %, not % event %', new.projection_id, e->>'sport', e->>'event_id', new.sport, new.event_id using errcode = 'check_violation';
  end if;
  /* a moneyline or 1X2 comparison carries the frozen probability itself, never a different number */
  if new.market in ('moneyline', 'three_way') and new.model_probability is not null then
    ps := nullif(e->>('p_' || new.side), '')::numeric;
    if ps is null or abs(ps - new.model_probability) > 0.0005 then
      raise exception 'market_comparisons: model probability % for % is not the frozen projection''s %', new.model_probability, new.side, coalesce(ps::text, 'none') using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists market_comparisons_frozen_check_trg on public.market_comparisons;
create trigger market_comparisons_frozen_check_trg before insert on public.market_comparisons for each row execute function public.market_comparisons_frozen_check();
revoke all on function public.market_comparisons_frozen_check() from public;

-- ---------------------------------------------------------------------------
-- 3. WRITE ONCE, NO READER DELETES, ONE RETENTION DOOR
-- ---------------------------------------------------------------------------
create or replace function public.independent_projections_immutable()
returns trigger language plpgsql as $$
begin
  raise exception '% is write-once: row % cannot be updated', tg_table_name, old.id using errcode = 'restrict_violation';
end $$;
create or replace function public.independent_projections_no_delete()
returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('edgedesk.projections_prune', true), '') = 'on' then return old; end if;
  raise exception '% rows are not deleted (row %); retention runs through independent_projections_prune()', tg_table_name, old.id using errcode = 'restrict_violation';
end $$;
do $trg$
declare t text;
begin
  foreach t in array array['projection_snapshots','market_comparisons'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_immutable_trg', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.independent_projections_immutable()', t || '_immutable_trg', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_delete_trg', t);
    execute format('create trigger %I before delete on public.%I for each row execute function public.independent_projections_no_delete()', t || '_no_delete_trg', t);
  end loop;
end $trg$;

/* Retention: rows older than p_days (default 400, at least 90). Comparisons first, so no comparison
   outlives its snapshot. */
create or replace function public.independent_projections_prune(p_days int default 400)
returns int language plpgsql security definer set search_path = public as $$
declare n1 int; n2 int; d int := greatest(coalesce(p_days, 400), 90);
begin
  perform set_config('edgedesk.projections_prune', 'on', true);
  delete from public.market_comparisons where created_at < now() - make_interval(days => d);
  get diagnostics n1 = row_count;
  delete from public.projection_snapshots s where s.created_at < now() - make_interval(days => d)
    and not exists (select 1 from public.market_comparisons c where c.user_id is not distinct from s.user_id and c.snapshot_id = s.snapshot_id);
  get diagnostics n2 = row_count;
  perform set_config('edgedesk.projections_prune', 'off', true);
  return n1 + n2;
end $$;
revoke all on function public.independent_projections_prune(int) from public;
do $grant$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public.independent_projections_prune(int) to service_role; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.independent_projections_prune(int) from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.independent_projections_prune(int) from anon; end if;
end $grant$;

-- ---------------------------------------------------------------------------
-- 4. ROW LEVEL SECURITY AND GRANTS
-- ---------------------------------------------------------------------------
alter table public.projection_snapshots enable row level security;
alter table public.market_comparisons enable row level security;
drop policy if exists projection_snapshots_insert_own on public.projection_snapshots;
create policy projection_snapshots_insert_own on public.projection_snapshots for insert to authenticated with check (user_id = auth.uid());
drop policy if exists projection_snapshots_select_own on public.projection_snapshots;
create policy projection_snapshots_select_own on public.projection_snapshots for select to authenticated using (user_id = auth.uid());
drop policy if exists market_comparisons_insert_own on public.market_comparisons;
create policy market_comparisons_insert_own on public.market_comparisons for insert to authenticated with check (user_id = auth.uid());
drop policy if exists market_comparisons_select_own on public.market_comparisons;
create policy market_comparisons_select_own on public.market_comparisons for select to authenticated using (user_id = auth.uid());
-- revoke first: Supabase's default privileges grant ALL, and TRUNCATE bypasses the row triggers
revoke all on public.projection_snapshots from authenticated;
revoke all on public.market_comparisons from authenticated;
grant select, insert on public.projection_snapshots to authenticated;
grant select, insert on public.market_comparisons to authenticated;
grant usage, select on sequence public.projection_snapshots_id_seq to authenticated;
grant usage, select on sequence public.market_comparisons_id_seq to authenticated;
do $anon$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.projection_snapshots from anon;
    revoke all on public.market_comparisons from anon;
  end if;
end $anon$;

notify pgrst, 'reload schema';

-- THE REPORT.
select 'projection_snapshots table' as piece, case when to_regclass('public.projection_snapshots') is not null then 'ok' else 'CHECK THIS' end as state
union all select 'market_comparisons table', case when to_regclass('public.market_comparisons') is not null then 'ok' else 'CHECK THIS' end
union all select 'independence check on snapshots', case when exists (select 1 from pg_trigger where tgname = 'projection_snapshots_check_trg') then 'ok' else 'CHECK THIS' end
union all select 'frozen-first check on comparisons', case when exists (select 1 from pg_trigger where tgname = 'market_comparisons_frozen_check_trg') then 'ok' else 'CHECK THIS' end
union all select 'write-once triggers', case when (select count(*) from pg_trigger where tgname in ('projection_snapshots_immutable_trg','market_comparisons_immutable_trg')) = 2 then 'ok' else 'CHECK THIS' end
union all select 'no-delete triggers', case when (select count(*) from pg_trigger where tgname in ('projection_snapshots_no_delete_trg','market_comparisons_no_delete_trg')) = 2 then 'ok' else 'CHECK THIS' end
union all select 'row level security', case when (select count(*) from pg_class where oid in ('public.projection_snapshots'::regclass, 'public.market_comparisons'::regclass) and relrowsecurity) = 2 then 'ok' else 'CHECK THIS' end
union all select 'per-user keys', case when (select count(*) from pg_constraint where conname in ('projection_snapshots_user_snapshot_key','market_comparisons_user_comparison_key')) = 2 then 'ok' else 'CHECK THIS' end
union all select 'ledgers not writable beyond insert', case when not exists (select 1 from information_schema.role_table_grants where grantee = 'authenticated' and table_schema = 'public'
    and table_name in ('projection_snapshots','market_comparisons') and privilege_type not in ('SELECT','INSERT')) then 'ok' else 'CHECK THIS' end
union all select 'retention function', case when to_regprocedure('public.independent_projections_prune(int)') is not null then 'ok' else 'CHECK THIS' end;
