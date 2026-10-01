-- ============================================================================
-- EDGEDESK — pnl_grades: profit and loss of every flagged edge in `signals`.
-- docs/pnl/GRADES.md has the full account. The rules, in short:
--   · one row per flag, keyed by sig_key (primary key AND foreign key to
--     signals), so a flag can never be graded twice;
--   · 1 unit flat at flagged_best_dec, the price capture froze when it flagged
--     (the number a reader could have bet). Never the close, never a later
--     price, never first_best_dec. No flag price → ungraded_missing_price;
--   · win = price − 1 (decimal) = odds/100 or 100/|odds| (American);
--     loss = −1; push = 0 and still counts as 1u risked; void is excluded
--     and counted;
--   · the P&L at the closing price sits beside it, for comparison only;
--   · verdict = the BET / LEAN the board showed AT FLAG TIME, rebuilt from the
--     frozen flagged_* columns with the board's own rule (app.html). Nothing
--     in capture, the board or the research protocol changes;
--   · written by a trigger on signals in the same transaction that flags or
--     settles the row, and by pnl_grades_backfill() for history (idempotent);
--   · every change to a written row is appended to pnl_grades_history, and
--     calc_version names the arithmetic that produced it;
--   · RLS: anyone may read a row whose game has started; only this file's
--     functions write.
-- Idempotent and additive. Ends in a report whose rows must all read ok.
-- Run order: this file → pnl_grades_sync.sql → pnl_grades_analytics.sql, then
-- the dry run:  select * from public.pnl_grades_backfill(false);
-- ============================================================================

do $dep$
declare miss text;
begin
  if to_regclass('public.signals') is null then
    raise exception 'pnl_grades.sql: public.signals does not exist';
  end if;
  select string_agg(c, ', ') into miss from unnest(array['sig_key','sport_key','sport_title','event_id','home_team','away_team',
    'commence_time','market','selection','point','flagged_at','flagged_edge','flagged_best_dec','flagged_best_book','result','graded_at']) c
  where not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'signals' and column_name = c);
  if miss is not null then raise exception 'pnl_grades.sql: public.signals has no %', miss; end if;
  select string_agg(c, ', ') into miss from unnest(array['flagged_tier','flagged_reference_type','flagged_fresh_books','flagged_policy']) c
  where not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'signals' and column_name = c);
  if miss is not null then raise exception 'pnl_grades.sql: signals has no % — run supabase/capture_v9_qualification.sql first', miss; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'signals' and column_name = 'closing_dec') then
    raise exception 'pnl_grades.sql: signals has no closing_dec — run supabase/close_v7_parity.sql first';
  end if;
  if not exists (select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
                 where i.indrelid = 'public.signals'::regclass and i.indisunique and i.indnkeyatts = 1
                   and i.indpred is null and i.indexprs is null and a.attname = 'sig_key') then
    raise exception 'pnl_grades.sql: signals.sig_key carries no unique index, so a P&L row cannot reference it';
  end if;
end $dep$;

create table if not exists public.pnl_grades (
  sig_key                 text primary key references public.signals (sig_key),
  sport_key               text,
  sport_title             text,
  event_id                text,
  event_label             text,
  event_at                timestamptz,
  market                  text,
  market_type             text not null,
  selection               text,
  point                   numeric,
  participant             text,
  flagged_at              timestamptz not null,
  flagged_book            text,
  flagged_tier            text,
  flagged_edge            numeric,
  flagged_reference_type  text,
  flagged_fresh_books     integer,
  flagged_policy          text,
  verdict                 text not null,
  verdict_reason          text not null,
  stake_units             numeric not null,
  price_at_flag           numeric,
  price_at_flag_american  numeric,
  price_at_close          numeric,
  price_at_close_american numeric,
  result                  text,
  settled_at              timestamptz,
  pnl_units               numeric,
  pnl_units_at_close      numeric,
  pnl_status              text not null,
  pnl_reason              text,
  calc_version            text not null,
  computed_at             timestamptz not null default now(),
  created_at              timestamptz not null default now()
);
comment on table public.pnl_grades is
  'P&L of every flagged edge: 1u flat at the price frozen at flag time (flagged_best_dec). One row per flag. '
  'Written only by the signals trigger and pnl_grades_backfill(). See docs/pnl/GRADES.md.';

do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'pnl_grades_enums') then
    alter table public.pnl_grades add constraint pnl_grades_enums check (
      verdict in ('BET', 'LEAN', 'PASS', 'UNLABELLED')
      and (result is null or result in ('win', 'loss', 'push', 'void'))
      and pnl_status in ('graded', 'void', 'ungraded_missing_price', 'ungraded_unsettled', 'ungraded_unsupported', 'not_a_bet')
      and stake_units in (0, 1) and (stake_units = 0) = (verdict = 'PASS'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pnl_grades_prices_valid') then
    alter table public.pnl_grades add constraint pnl_grades_prices_valid check (
      (price_at_flag is null or price_at_flag > 1) and (price_at_close is null or price_at_close > 1));
  end if;
  -- no flag price, no P&L; only a graded row carries one
  if not exists (select 1 from pg_constraint where conname = 'pnl_grades_no_invented_pnl') then
    alter table public.pnl_grades add constraint pnl_grades_no_invented_pnl check (
      ((pnl_status = 'graded') = (pnl_units is not null))
      and (pnl_status <> 'graded' or (price_at_flag is not null and result in ('win', 'loss', 'push') and stake_units = 1))
      and (pnl_units_at_close is null or (pnl_status = 'graded' and price_at_close is not null)));
  end if;
end $c$;

create index if not exists pnl_grades_sport_idx on public.pnl_grades (sport_key, verdict, pnl_status);
create index if not exists pnl_grades_event_at_idx on public.pnl_grades (event_at);

create table if not exists public.pnl_grades_history (
  id         bigserial primary key,
  sig_key    text not null,
  changed_at timestamptz not null default now(),
  change     text not null,
  before     jsonb not null,
  after      jsonb not null
);
comment on table public.pnl_grades_history is
  'Append-only. Every change to a written pnl_grades row: a settlement that moved, a recalculation under a new calc_version.';

create table if not exists public.pnl_grades_errors (
  id       bigserial primary key,
  sig_key  text,
  at       timestamptz not null default now(),
  sqlstate text,
  message  text
);
comment on table public.pnl_grades_errors is
  'A flag or settlement the trigger could not grade. The signals write itself always succeeds; pnl_reconciliation() reports these.';

-- ---- the arithmetic --------------------------------------------------------
create or replace function public.pnl_calc_version() returns text
language sql immutable as $f$ select 'pnl-v1'::text $f$;

create or replace function public.pnl_norm_result(p text) returns text
language sql immutable as $f$
  select case lower(btrim(coalesce(p, '')))
    when 'win' then 'win' when 'won' then 'win' when 'w' then 'win'
    when 'loss' then 'loss' when 'lost' then 'loss' when 'lose' then 'loss' when 'l' then 'loss'
    when 'push' then 'push' when 'p' then 'push' when 'tie' then 'push'
    when 'void' then 'void' when 'cancelled' then 'void' when 'canceled' then 'void' when 'no action' then 'void'
    when 'pending' then 'pending' when '' then null
    else 'unknown' end
$f$;

-- 1u at American odds: win +odds/100 or 100/|odds|, loss −1, push 0, else none
create or replace function public.pnl_profit_american(p_odds numeric, p_result text) returns numeric
language sql immutable as $f$
  select case
    when p_odds is null or abs(p_odds) < 100 then null
    when public.pnl_norm_result(p_result) = 'win' then case when p_odds > 0 then p_odds / 100 else 100 / abs(p_odds) end
    when public.pnl_norm_result(p_result) = 'loss' then -1::numeric
    when public.pnl_norm_result(p_result) = 'push' then 0::numeric
  end
$f$;

-- the same rule on the decimal price capture stores: a win pays price − 1
create or replace function public.pnl_profit_decimal(p_dec numeric, p_result text) returns numeric
language sql immutable as $f$
  select case
    when p_dec is null or not (p_dec > 1) then null
    when public.pnl_norm_result(p_result) = 'win' then p_dec - 1
    when public.pnl_norm_result(p_result) = 'loss' then -1::numeric
    when public.pnl_norm_result(p_result) = 'push' then 0::numeric
  end
$f$;

-- decimal → American, unrounded (the page rounds for display)
create or replace function public.pnl_american(p_dec numeric) returns numeric
language sql immutable as $f$
  select case when p_dec is null or not (p_dec > 1) then null
              when p_dec >= 2 then (p_dec - 1) * 100 else -100 / (p_dec - 1) end
$f$;

-- app.html TRUSTED: a substring match on the lower-cased book name
create or replace function public.pnl_trusted_book(p_book text) returns boolean
language sql immutable as $f$
  select p_book is not null and exists (
    select 1 from unnest(array['draftkings','fanduel','betmgm','caesars','espn bet','espnbet','fanatics','betrivers',
      'hard rock','hardrock','bet365','pinnacle','circa','fliff','ballybet','wynn','superbook']) t
    where strpos(lower(p_book), t) > 0)
$f$;

create or replace function public.pnl_market_type(p_market text) returns text
language sql immutable as $f$
  select case when p_market is null then 'other'
    when p_market = 'h2h' then 'moneyline'
    when p_market in ('spreads', 'alternate_spreads') then 'spread'
    when p_market in ('totals', 'alternate_totals') then 'total'
    when p_market ~ '^(player|batter|pitcher)_' then 'player_prop'
    else p_market end
$f$;

-- Guard: the P&L is always the arithmetic of the row's own price and result,
-- the sig_key never moves, and every real change is appended to the history.
create or replace function public.pnl_grades_guard() returns trigger
language plpgsql as $f$
declare o jsonb; n jsonb;
begin
  new.stake_units := case when new.verdict = 'PASS' then 0 else 1 end;
  new.price_at_flag_american := public.pnl_american(new.price_at_flag);
  new.price_at_close_american := public.pnl_american(new.price_at_close);
  new.pnl_units := case when new.pnl_status = 'graded' then public.pnl_profit_decimal(new.price_at_flag, new.result) end;
  new.pnl_units_at_close := case when new.pnl_status = 'graded' then public.pnl_profit_decimal(new.price_at_close, new.result) end;
  if tg_op = 'UPDATE' then
    if new.sig_key <> old.sig_key then raise exception 'pnl_grades: a row never changes flag'; end if;
    new.created_at := old.created_at;
    o := to_jsonb(old) - 'computed_at' - 'created_at'; n := to_jsonb(new) - 'computed_at' - 'created_at';
    if o = n then new.computed_at := old.computed_at; return new; end if;
    new.computed_at := now();
    insert into public.pnl_grades_history (sig_key, change, before, after)
    values (new.sig_key,
            case when old.result is distinct from new.result then 'result_changed'
                 when old.calc_version is distinct from new.calc_version then 'recalculated'
                 when old.price_at_flag is distinct from new.price_at_flag or old.price_at_close is distinct from new.price_at_close then 'price_changed'
                 else 'restated' end,
            o, n);
  end if;
  return new;
end $f$;
drop trigger if exists pnl_grades_guard_trg on public.pnl_grades;
create trigger pnl_grades_guard_trg before insert or update on public.pnl_grades for each row execute function public.pnl_grades_guard();

create or replace function public.pnl_grades_keep() returns trigger language plpgsql as $f$
begin raise exception '%: % is refused — the P&L record is kept forever', tg_table_name, tg_op; end $f$;
drop trigger if exists pnl_grades_no_delete_trg on public.pnl_grades;
create trigger pnl_grades_no_delete_trg before delete on public.pnl_grades for each row execute function public.pnl_grades_keep();
drop trigger if exists pnl_grades_no_truncate_trg on public.pnl_grades;
create trigger pnl_grades_no_truncate_trg before truncate on public.pnl_grades for each statement execute function public.pnl_grades_keep();
drop trigger if exists pnl_grades_history_frozen_trg on public.pnl_grades_history;
create trigger pnl_grades_history_frozen_trg before update or delete on public.pnl_grades_history for each row execute function public.pnl_grades_keep();

alter table public.pnl_grades enable row level security;
alter table public.pnl_grades_history enable row level security;
alter table public.pnl_grades_errors enable row level security;
-- a flag whose game has not started is the live board: it stays private
drop policy if exists pnl_grades_public_read on public.pnl_grades;
create policy pnl_grades_public_read on public.pnl_grades for select to anon, authenticated
  using (settled_at is not null or (event_at is not null and event_at <= now()));
revoke all on public.pnl_grades, public.pnl_grades_history, public.pnl_grades_errors from anon, authenticated;
grant select on public.pnl_grades to anon, authenticated;
grant select on public.pnl_grades, public.pnl_grades_history, public.pnl_grades_errors to service_role;

notify pgrst, 'reload schema';

-- THE REPORT.
select piece, state from (
  select 'pnl_grades: one row per flag, keyed and referenced by sig_key' as piece,
    case when exists (select 1 from pg_constraint where conrelid = 'public.pnl_grades'::regclass and contype = 'p')
          and exists (select 1 from pg_constraint where conrelid = 'public.pnl_grades'::regclass and contype = 'f' and confrelid = 'public.signals'::regclass)
         then 'ok' else 'CHECK THIS' end as state
  union all select 'odds math: +150 win 1.5, -110 win 0.9091, loss -1, push 0, void none',
    case when public.pnl_profit_american(150, 'win') = 1.5 and round(public.pnl_profit_american(-110, 'win'), 4) = 0.9091
          and public.pnl_profit_american(-110, 'loss') = -1 and public.pnl_profit_american(-110, 'push') = 0
          and public.pnl_profit_american(-110, 'void') is null and public.pnl_profit_american(50, 'win') is null
          and public.pnl_profit_decimal(2.5, 'win') = 1.5 then 'ok' else 'CHECK THIS' end
  union all select 'no flag price, no P&L (constraint)', case when exists (select 1 from pg_constraint where conname = 'pnl_grades_no_invented_pnl') then 'ok' else 'CHECK THIS' end
  union all select 'derived P&L, history, no delete or truncate', case when (select count(*) from pg_trigger where tgname in
    ('pnl_grades_guard_trg', 'pnl_grades_no_delete_trg', 'pnl_grades_no_truncate_trg', 'pnl_grades_history_frozen_trg')) = 4 then 'ok' else 'CHECK THIS' end
  union all select 'RLS on; clients read, never write', case when (select relrowsecurity from pg_class where oid = 'public.pnl_grades'::regclass)
    and has_table_privilege('anon', 'public.pnl_grades', 'select') and not has_table_privilege('anon', 'public.pnl_grades', 'insert')
    and not has_table_privilege('authenticated', 'public.pnl_grades', 'update') then 'ok' else 'CHECK THIS' end
  union all select 'no row carries an invented P&L', case when not exists (select 1 from public.pnl_grades
    where pnl_units is not null and (pnl_status <> 'graded' or price_at_flag is null)) then 'ok' else 'CHECK THIS' end
) r order by 1;
