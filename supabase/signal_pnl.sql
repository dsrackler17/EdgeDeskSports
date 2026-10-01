-- ============================================================================
-- EDGEDESK — profit and loss of every flagged edge (public.signals). 1 of 3.
-- docs/pnl/EDGE_PNL.md has the full account. In short:
--   · one row per flag that reached its close or settlement, keyed by
--     signals.sig_key (primary + foreign key): a flag never grades twice.
--   · 1 unit, flat, at the price FROZEN WHEN FLAGGED (flagged_best_dec).
--     Win at +odds = odds/100, at -odds = 100/|odds|; loss -1; push 0. From
--     the stored decimal a win pays d - 1: the same number, full precision.
--   · void / cancelled: not a bet, counted on its own. No valid flag price:
--     ungraded_missing_price. Nothing estimated or borrowed from the close.
--   · pnl_units_at_close (closing_dec) is a comparison only.
--   · calc_version on every row; a change to a settled row goes to
--     pnl_grade_history first. The table refuses a figure its math did not
--     produce, and refuses deletes. Public once the game starts.
-- Order: this file, signal_pnl_summary.sql, signal_pnl_sync.sql (the hook),
-- then the backfill dry run, signal_pnl_backfill.sql.
-- Idempotent, additive, no psql meta-commands, ends in a report.
-- ============================================================================

do $dep$
declare missing text;
begin
  if to_regclass('public.signals') is null then
    raise exception 'signal_pnl.sql needs public.signals (written by the capture function)';
  end if;
  select string_agg(c, ', ') into missing
  from unnest(array['sig_key', 'flagged_at', 'flagged_best_dec', 'result', 'closed_at', 'commence_time', 'market', 'selection']) c
  where not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'signals' and column_name = c);
  if missing is not null then
    raise exception 'signal_pnl.sql: public.signals has no column(s) %', missing;
  end if;
end $dep$;

-- ── THE MATH ────────────────────────────────────────────────────────────────
create or replace function public.pnl_num(p text) returns numeric language sql immutable as $f$
  select case when p ~ '^\s*[-+]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?\s*$' then btrim(p)::numeric end
$f$;

-- settle's word for the outcome, read into win | loss | push | void (NULL: unreadable)
create or replace function public.pnl_result(p text) returns text language sql immutable as $f$
  select case
    when lower(btrim(p)) in ('win', 'won') then 'win'
    when lower(btrim(p)) in ('loss', 'lost', 'lose') then 'loss'
    when lower(btrim(p)) = 'push' then 'push'
    when lower(btrim(p)) in ('void', 'voided', 'cancelled', 'canceled', 'cancel', 'no_action', 'no action', 'noaction',
                             'postponed', 'abandoned', 'refund', 'refunded', 'no_bet', 'no bet') then 'void'
  end
$f$;

-- a real price: decimal above 1.00 and no longer than +100000
create or replace function public.pnl_price_ok(p_dec numeric) returns boolean language sql immutable as $f$
  select p_dec is not null and p_dec > 1 and p_dec <= 1001
$f$;

create or replace function public.pnl_american(p_dec numeric) returns numeric language sql immutable as $f$
  select case when not public.pnl_price_ok(p_dec) then null
              when p_dec >= 2 then (p_dec - 1) * 100
              else -100 / (p_dec - 1) end
$f$;

-- a win pays d - 1 at the decimal capture stored: odds/100 at +odds, 100/|odds| at -odds
-- (pnl_units_american in signal_pnl_summary.sql is the brief's formula, word for word)
create or replace function public.pnl_units_decimal(p_dec numeric, p_result text) returns numeric language sql immutable as $f$
  select case
    when not public.pnl_price_ok(p_dec) then null
    when public.pnl_result(p_result) = 'win' then p_dec - 1
    when public.pnl_result(p_result) = 'loss' then -1::numeric
    when public.pnl_result(p_result) = 'push' then 0::numeric
  end
$f$;

-- ── THE TABLE ───────────────────────────────────────────────────────────────
create table if not exists public.pnl_grades (
  sig_key text primary key,
  sport_key text,
  sport_title text,
  event_id text,
  home_team text,
  away_team text,
  commence_time timestamptz,
  game_date date,
  market text,
  market_type text not null,
  selection text,
  point numeric,
  book text,
  tier text not null,
  flagged_policy text,
  flagged_at timestamptz,
  flagged_edge numeric,
  record_scope text not null,
  stake_units numeric not null,
  price_at_flag numeric,
  price_at_flag_dec numeric,
  price_at_close numeric,
  price_at_close_dec numeric,
  close_book text,
  result text,
  result_raw text,
  pnl_units numeric,
  pnl_units_at_close numeric,
  pnl_status text not null,
  ungraded_reason text,
  settled_at timestamptz,
  closed_at timestamptz,
  calc_version text not null,
  revision int not null default 1,
  created_at timestamptz not null default now(),
  computed_at timestamptz not null default now()
);
comment on table public.pnl_grades is
  'P&L of every flagged edge: 1u flat at the price frozen when it was flagged. One row per signals.sig_key, written only by pnl_grade_write(). docs/pnl/EDGE_PNL.md';

do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'pnl_grades_enums') then
    alter table public.pnl_grades add constraint pnl_grades_enums check (
      tier in ('A', 'B', 'legacy')
      and record_scope in ('record', 'outside_edge_band')
      and (result is null or result in ('win', 'loss', 'push', 'void'))
      and pnl_status in ('graded', 'ungraded_missing_price', 'ungraded_unsettled', 'void')
      and stake_units in (0, 1));
  end if;
  -- the table refuses a number its own math did not produce
  if not exists (select 1 from pg_constraint where conname = 'pnl_grades_math') then
    alter table public.pnl_grades add constraint pnl_grades_math check (
      (pnl_status = 'graded') = (pnl_units is not null)
      and (pnl_status <> 'graded' or (public.pnl_price_ok(price_at_flag_dec) and result in ('win', 'loss', 'push') and stake_units = 1
           and (calc_version <> 'pnl-v1' or pnl_units = public.pnl_units_decimal(price_at_flag_dec, result))))
      and (pnl_status = 'graded' or stake_units = 0)
      and (pnl_status <> 'void' or result = 'void')
      and (pnl_units_at_close is null or (pnl_status = 'graded'
           and (calc_version <> 'pnl-v1' or pnl_units_at_close = public.pnl_units_decimal(price_at_close_dec, result)))));
  end if;
  -- linked to the signal it grades (capture upserts on a unique sig_key)
  if not exists (select 1 from pg_constraint where conname = 'pnl_grades_signal_fk')
     and exists (select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
                 where i.indrelid = 'public.signals'::regclass and i.indisunique and i.indnatts = 1 and i.indpred is null and a.attname = 'sig_key') then
    alter table public.pnl_grades add constraint pnl_grades_signal_fk
      foreign key (sig_key) references public.signals (sig_key) on delete restrict;
  end if;
end $c$;

create index if not exists pnl_grades_scope_idx on public.pnl_grades (record_scope, pnl_status, sport_key, tier);
create index if not exists pnl_grades_date_idx on public.pnl_grades (game_date);

-- every change to a settled row, kept forever
create table if not exists public.pnl_grade_history (
  id bigint generated always as identity primary key,
  sig_key text not null references public.pnl_grades (sig_key),
  changed_at timestamptz not null default now(),
  source text not null,
  reason text not null,
  previous jsonb not null,
  current jsonb not null
);
create index if not exists pnl_grade_history_sig_idx on public.pnl_grade_history (sig_key, changed_at);

create or replace function public.pnl_keep() returns trigger language plpgsql as $k$
begin raise exception '%: % is refused — P&L rows and their history are kept forever', tg_table_name, tg_op; end $k$;
drop trigger if exists pnl_grades_no_delete_trg on public.pnl_grades;
create trigger pnl_grades_no_delete_trg before delete on public.pnl_grades for each row execute function public.pnl_keep();
drop trigger if exists pnl_grades_no_truncate_trg on public.pnl_grades;
create trigger pnl_grades_no_truncate_trg before truncate on public.pnl_grades for each statement execute function public.pnl_keep();
drop trigger if exists pnl_grade_history_frozen_trg on public.pnl_grade_history;
create trigger pnl_grade_history_frozen_trg before update or delete on public.pnl_grade_history for each row execute function public.pnl_keep();

-- ── ONE SIGNAL → ONE ROW (reads only its argument) ──────────────────────────
create or replace function public.pnl_grade_compute(p jsonb)
returns public.pnl_grades language plpgsql stable as $g$
declare g public.pnl_grades; mkt text; dec numeric; cdec numeric; res text;
begin
  -- a flag that has reached its close or its settlement; anything else is not graded yet
  if p ->> 'sig_key' is null or p ->> 'flagged_at' is null or (p ->> 'result' is null and p ->> 'closed_at' is null) then
    return null;
  end if;
  g.sig_key := p ->> 'sig_key';
  g.sport_key := p ->> 'sport_key'; g.sport_title := p ->> 'sport_title';
  g.event_id := p ->> 'event_id'; g.home_team := p ->> 'home_team'; g.away_team := p ->> 'away_team';
  g.commence_time := (p ->> 'commence_time')::timestamptz;
  g.flagged_at := (p ->> 'flagged_at')::timestamptz;
  g.game_date := (coalesce(g.commence_time, g.flagged_at) at time zone 'America/New_York')::date;
  g.market := p ->> 'market';
  mkt := lower(coalesce(g.market, ''));
  g.market_type := case
    when mkt in ('h2h', 'moneyline') then 'moneyline'
    when mkt in ('spreads', 'spread', 'alternate_spreads') then 'spread'
    when mkt in ('totals', 'total', 'alternate_totals') then 'total'
    when mkt like 'player\_%' or lower(coalesce(p ->> 'is_player_prop', '')) = 'true' then 'player_prop'
    when mkt like '%team\_total%' then 'team_total'
    else 'other' end;
  g.selection := p ->> 'selection'; g.point := public.pnl_num(p ->> 'point'); g.book := p ->> 'flagged_best_book';
  g.tier := case when p ->> 'flagged_tier' in ('A', 'B') then p ->> 'flagged_tier' else 'legacy' end;
  g.flagged_policy := p ->> 'flagged_policy';
  g.flagged_edge := public.pnl_num(p ->> 'flagged_edge');
  -- the same rows as the CLV record: an edge between 0.5% and 10% when flagged
  g.record_scope := case when g.flagged_edge >= 0.005 and g.flagged_edge <= 0.1 then 'record' else 'outside_edge_band' end;
  dec := public.pnl_num(p ->> 'flagged_best_dec');
  g.price_at_flag_dec := dec;
  g.price_at_flag := public.pnl_american(dec);
  cdec := public.pnl_num(p ->> 'closing_dec');
  if public.pnl_price_ok(cdec) then g.price_at_close_dec := cdec; g.price_at_close := public.pnl_american(cdec); end if;
  g.close_book := p ->> 'closing_book';
  g.result_raw := p ->> 'result';
  res := public.pnl_result(g.result_raw);
  g.result := res;
  g.settled_at := (p ->> 'graded_at')::timestamptz;
  g.closed_at := (p ->> 'closed_at')::timestamptz;
  g.calc_version := 'pnl-v1';
  g.stake_units := 0;
  if g.result_raw is null then
    g.pnl_status := 'ungraded_unsettled'; g.ungraded_reason := 'awaiting_result';
  elsif res is null then
    g.pnl_status := 'ungraded_unsettled'; g.ungraded_reason := 'unrecognized_result';
  elsif res = 'void' then
    g.pnl_status := 'void';
  elsif dec is null then
    g.pnl_status := 'ungraded_missing_price'; g.ungraded_reason := 'no_flag_price';
  elsif not public.pnl_price_ok(dec) then
    g.pnl_status := 'ungraded_missing_price'; g.ungraded_reason := 'invalid_flag_price';
  else
    g.pnl_status := 'graded'; g.stake_units := 1;
    g.pnl_units := public.pnl_units_decimal(dec, res);
    g.pnl_units_at_close := public.pnl_units_decimal(g.price_at_close_dec, res);
  end if;
  g.revision := 1; g.created_at := now(); g.computed_at := now();
  return g;
end $g$;

-- ── THE ONE WRITER ──────────────────────────────────────────────────────────
-- inserts a new row, updates one whose inputs moved (logging the old version
-- first when it was already settled), or leaves it alone. Says which.
create or replace function public.pnl_grade_write(p jsonb, p_source text default 'sync')
returns text language plpgsql security definer set search_path = public as $w$
declare g public.pnl_grades; cur public.pnl_grades; a jsonb; b jsonb; k text; diff text := ''; cols text;
begin
  g := public.pnl_grade_compute(p);
  if g.sig_key is null then return 'skipped'; end if;
  insert into public.pnl_grades select (g).* on conflict (sig_key) do nothing;
  if found then return 'inserted'; end if;
  select * into cur from public.pnl_grades where sig_key = g.sig_key for update;
  a := to_jsonb(cur) - array['revision', 'created_at', 'computed_at'];
  b := to_jsonb(g) - array['revision', 'created_at', 'computed_at'];
  if a = b then return 'unchanged'; end if;
  for k in select key from jsonb_each(b) order by key loop
    if (a -> k) is distinct from (b -> k) then
      diff := diff || case when diff = '' then '' else '; ' end || k || ': ' || coalesce(a ->> k, 'null') || ' -> ' || coalesce(b ->> k, 'null');
    end if;
  end loop;
  if cur.pnl_status <> 'ungraded_unsettled' or cur.calc_version <> g.calc_version then
    insert into public.pnl_grade_history (sig_key, source, reason, previous, current)
    values (g.sig_key, p_source, diff, to_jsonb(cur), to_jsonb(g));
  end if;
  g.revision := cur.revision + 1; g.created_at := cur.created_at; g.computed_at := now();
  select string_agg(quote_ident(attname), ', ' order by attnum) into cols
  from pg_attribute where attrelid = 'public.pnl_grades'::regclass and attnum > 0 and not attisdropped and attname <> 'sig_key';
  execute format('update public.pnl_grades set (%s) = (select %s from jsonb_populate_record(null::public.pnl_grades, $1)) where sig_key = $2', cols, cols)
    using to_jsonb(g), g.sig_key;
  return 'updated';
end $w$;

-- ── WHO MAY READ AND WRITE ─────────────────────────────────────────────────
alter table public.pnl_grades enable row level security;
alter table public.pnl_grade_history enable row level security;
-- public once its game has started: close stamps a row ~35 minutes BEFORE
-- kickoff, and the live board stays behind the paywall until then
drop policy if exists pnl_grades_public_read on public.pnl_grades;
create policy pnl_grades_public_read on public.pnl_grades for select to anon, authenticated
  using (result_raw is not null or (commence_time is not null and commence_time <= now()));
drop policy if exists pnl_grade_history_public_read on public.pnl_grade_history;
create policy pnl_grade_history_public_read on public.pnl_grade_history for select to anon, authenticated
  using (exists (select 1 from public.pnl_grades g where g.sig_key = pnl_grade_history.sig_key));
revoke all on public.pnl_grades, public.pnl_grade_history from anon, authenticated;
grant select on public.pnl_grades, public.pnl_grade_history to anon, authenticated;
grant select, insert, update on public.pnl_grades, public.pnl_grade_history to service_role;
revoke all on function public.pnl_grade_write(jsonb, text) from public, anon, authenticated;
grant execute on function public.pnl_grade_write(jsonb, text) to service_role;

notify pgrst, 'reload schema';

-- THE REPORT. Every row should read ok.
select n, piece, state from (
  select 1 as n, 'pnl_grades exists, one row per signals.sig_key' as piece,
    case when exists (select 1 from pg_constraint where conrelid = 'public.pnl_grades'::regclass and contype = 'p') then 'ok' else 'CHECK THIS' end as state
  union all select 2, 'every row is linked to its signal (foreign key)',
    case when exists (select 1 from pg_constraint where conname = 'pnl_grades_signal_fk') then 'ok' else 'CHECK THIS: signals.sig_key has no unique index' end
  union all select 3, 'the table refuses a figure its math did not produce',
    case when exists (select 1 from pg_constraint where conname = 'pnl_grades_math') then 'ok' else 'CHECK THIS' end
  union all select 4, 'no delete, no truncate; history append-only',
    case when (select count(*) from pg_trigger where tgname in ('pnl_grades_no_delete_trg', 'pnl_grades_no_truncate_trg', 'pnl_grade_history_frozen_trg')) = 3 then 'ok' else 'CHECK THIS' end
  union all select 5, 'RLS on; anyone reads, only the service role writes',
    case when (select relrowsecurity from pg_class where oid = 'public.pnl_grades'::regclass)
      and has_table_privilege('anon', 'public.pnl_grades', 'select') and not has_table_privilege('anon', 'public.pnl_grades', 'insert')
      and not has_table_privilege('authenticated', 'public.pnl_grades', 'update')
      and not has_function_privilege('anon', 'public.pnl_grade_write(jsonb, text)', 'execute')
      and not has_function_privilege('authenticated', 'public.pnl_grade_write(jsonb, text)', 'execute') then 'ok' else 'CHECK THIS' end
  union all select 6, 'no row carries P&L without a valid flag price',
    case when not exists (select 1 from public.pnl_grades where pnl_units is not null and not public.pnl_price_ok(price_at_flag_dec)) then 'ok' else 'CHECK THIS' end
) r order by 1;
