-- ============================================================================
-- EDGEDESK — flagged-edge P&L, 3 of 3: the hook, reconciliation, backfill.
-- Apply supabase/signal_pnl.sql and signal_pnl_summary.sql first.
--
-- THE HOOK. signals.result is written by the `settle` edge function (deployed,
-- not in this repository) and closed_at / closing_dec by `close`. A trigger on
-- signals writes the P&L row IN THE SAME TRANSACTION as either write, whichever
-- function made it: no cron, no second job, nothing to forget to deploy.
--   · it fires only when a P&L input column is written (capture's routine
--     refresh writes none of them) on a flagged row that has closed or settled;
--   · it can NEVER fail a settlement: any error is caught, written to
--     pnl_sync_errors, and pnl_reconciliation() shows it on the Records tab.
-- RECONCILIATION. pnl_reconciliation(): settled flags with no P&L row (must be
-- 0), rows whose inputs moved without a rewrite (must be 0), trigger errors.
-- BACKFILL. pnl_backfill() is a DRY RUN: counts, a 20-row sample and totals
-- per sport, nothing written. pnl_backfill(true) writes exactly that. Safe to
-- run again: one row per sig_key, a second run writes nothing.
-- pnl_verify(): every check, ok or CHECK THIS. (pnl_handcheck(10) is in
-- signal_pnl_summary.sql.)
-- Idempotent, additive, no psql meta-commands, ends in a report.
-- ============================================================================

do $dep$ begin
  if to_regclass('public.pnl_grades') is null or to_regclass('public.pnl_summary') is null then
    raise exception 'apply supabase/signal_pnl.sql, then supabase/signal_pnl_summary.sql, first';
  end if;
end $dep$;

create table if not exists public.pnl_sync_errors (
  id bigint generated always as identity primary key,
  sig_key text,
  at timestamptz not null default now(),
  sqlstate text,
  message text
);
create index if not exists pnl_sync_errors_at_idx on public.pnl_sync_errors (at);
alter table public.pnl_sync_errors enable row level security;
revoke all on public.pnl_sync_errors from anon, authenticated;
grant select, insert on public.pnl_sync_errors to service_role;

-- ── THE HOOK ────────────────────────────────────────────────────────────────
create or replace function public.pnl_signals_sync() returns trigger
language plpgsql security definer set search_path = public as $t$
begin
  begin
    perform public.pnl_grade_write(to_jsonb(new), case when tg_op = 'INSERT' then 'signal_insert' else 'settlement' end);
  exception when others then
    begin
      insert into public.pnl_sync_errors (sig_key, sqlstate, message) values (new.sig_key, sqlstate, left(sqlerrm, 500));
    exception when others then
      raise warning 'pnl_grades: could not sync % (%)', new.sig_key, sqlerrm;
    end;
  end;
  return null;
end $t$;
revoke all on function public.pnl_signals_sync() from public, anon, authenticated;

do $trg$
declare cols text;
begin
  select string_agg(quote_ident(c), ', ' order by c) into cols
  from unnest(array['flagged_at', 'flagged_best_dec', 'flagged_best_book', 'flagged_tier', 'flagged_edge',
                    'result', 'graded_at', 'closed_at', 'closing_dec', 'closing_book']) c
  where exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'signals' and column_name = c);
  drop trigger if exists pnl_signals_settle_trg on public.signals;
  execute format('create trigger pnl_signals_settle_trg after update of %s on public.signals for each row '
    'when (new.flagged_at is not null and (new.result is not null or new.closed_at is not null)) '
    'execute function public.pnl_signals_sync()', cols);
  drop trigger if exists pnl_signals_insert_trg on public.signals;
  create trigger pnl_signals_insert_trg after insert on public.signals for each row
    when (new.flagged_at is not null and (new.result is not null or new.closed_at is not null))
    execute function public.pnl_signals_sync();
end $trg$;

-- ── RECONCILIATION ──────────────────────────────────────────────────────────
create or replace function public.pnl_reconciliation()
returns jsonb language sql stable security definer set search_path = public as $r$
  with e as (
    select c.sig_key, c.result_raw is not null as settled, p.sig_key is not null as has_row,
      p.sig_key is not null and (to_jsonb(p) - array['revision', 'created_at', 'computed_at'])
        is distinct from (to_jsonb(c) - array['revision', 'created_at', 'computed_at']) as stale
    from public.signals x
    cross join lateral public.pnl_grade_compute(to_jsonb(x)) c
    left join public.pnl_grades p on p.sig_key = c.sig_key
    where x.flagged_at is not null and c.sig_key is not null
  )
  select jsonb_build_object(
    'settled_without_pnl', (select count(*) from e where settled and not has_row),
    'closed_without_pnl', (select count(*) from e where not settled and not has_row),
    'out_of_sync', (select count(*) from e where stale),
    'sync_errors_24h', (select count(*) from public.pnl_sync_errors where at > now() - interval '24 hours'),
    'last_error', (select message from public.pnl_sync_errors order by at desc limit 1),
    'overdue_unsettled', (select count(*) from public.signals where flagged_at is not null and result is null and commence_time < now() - interval '36 hours'),
    'rows', (select count(*) from public.pnl_grades),
    'graded', (select count(*) from public.pnl_grades where pnl_status = 'graded'),
    'last_write_at', (select max(computed_at) from public.pnl_grades),
    'ok', not exists (select 1 from e where not has_row or stale),
    'checked_at', now())
$r$;
revoke all on function public.pnl_reconciliation() from public;
grant execute on function public.pnl_reconciliation() to anon, authenticated, service_role;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
create or replace function public.pnl_verify()
returns table (n int, check_name text, got text, status text)
language plpgsql stable security definer set search_path = public as $v$
#variable_conflict use_column
declare rc jsonb := public.pnl_reconciliation(); s record; raw record; bad int;
begin
  select coalesce(sum(units_won), 0) u, coalesce(sum(graded), 0) g, coalesce(sum(wins), 0) w, coalesce(sum(losses), 0) l, coalesce(sum(pushes), 0) p
    into s from public.pnl_summary where grain = 'all' and breakdown = 'total';
  select coalesce(sum(pnl_units), 0) u, count(*) g, count(*) filter (where result = 'win') w,
         count(*) filter (where result = 'loss') l, count(*) filter (where result = 'push') p
    into raw from public.pnl_grades where record_scope = 'record' and pnl_status = 'graded';
  select count(*) into bad from public.pnl_grades where pnl_status = 'graded' and pnl_units is distinct from public.pnl_units_decimal(price_at_flag_dec, result);
  return query values
    (1, '+150 win = 1.50', public.pnl_units_american(150, 'win')::text, case when public.pnl_units_american(150, 'win') = 1.5 then 'ok' else 'CHECK THIS' end),
    (2, '-110 win = 0.909', round(public.pnl_units_american(-110, 'win'), 3)::text, case when round(public.pnl_units_american(-110, 'win'), 3) = 0.909 then 'ok' else 'CHECK THIS' end),
    (3, 'loss = -1', public.pnl_units_american(-110, 'loss')::text, case when public.pnl_units_american(-110, 'loss') = -1 then 'ok' else 'CHECK THIS' end),
    (4, 'push = 0', public.pnl_units_american(-110, 'push')::text, case when public.pnl_units_american(-110, 'push') = 0 then 'ok' else 'CHECK THIS' end),
    (5, 'void = not a bet (no P&L)', coalesce(public.pnl_units_american(-110, 'void')::text, 'null'), case when public.pnl_units_american(-110, 'void') is null then 'ok' else 'CHECK THIS' end),
    (6, 'pnl_summary all-time units = raw SQL sum', s.u::text || ' = ' || raw.u::text, case when s.u = raw.u then 'ok' else 'CHECK THIS' end),
    (7, 'pnl_summary W-L-P = raw SQL count', s.w || '-' || s.l || '-' || s.p || ' = ' || raw.w || '-' || raw.l || '-' || raw.p,
      case when (s.g, s.w, s.l, s.p) = (raw.g, raw.w, raw.l, raw.p) then 'ok' else 'CHECK THIS' end),
    (8, 'every graded row equals its own math', bad::text || ' off', case when bad = 0 then 'ok' else 'CHECK THIS' end),
    (9, 'settled flags with no P&L row', rc ->> 'settled_without_pnl', case when (rc ->> 'settled_without_pnl')::int = 0 then 'ok' else 'CHECK THIS' end),
    (10, 'closed flags with no P&L row', rc ->> 'closed_without_pnl', case when (rc ->> 'closed_without_pnl')::int = 0 then 'ok' else 'CHECK THIS' end),
    (11, 'P&L rows out of sync with their signal', rc ->> 'out_of_sync', case when (rc ->> 'out_of_sync')::int = 0 then 'ok' else 'CHECK THIS' end),
    (12, 'hook errors in the last 24h', rc ->> 'sync_errors_24h', case when (rc ->> 'sync_errors_24h')::int = 0 then 'ok' else 'CHECK THIS' end);
end $v$;

-- ── BACKFILL: dry run by default ───────────────────────────────────────────
create or replace function public.pnl_backfill(p_commit boolean default false)
returns table (section text, line int, sport text, item text, pick text, price text, result text, pnl_units text, note text)
language plpgsql volatile security definer set search_path = public as $b$
#variable_conflict use_column
declare r record; w text; ins int := 0; upd int := 0; meta text[] := array['revision', 'created_at', 'computed_at'];
begin
  create temp table if not exists pnl_bf (like public.pnl_grades, src jsonb, action text) on commit drop;
  truncate pnl_bf;
  insert into pnl_bf
    select c.*, to_jsonb(x),
      case when p.sig_key is null then 'insert' when (to_jsonb(p) - meta) = (to_jsonb(c) - meta) then 'unchanged' else 'update' end
    from public.signals x
    cross join lateral public.pnl_grade_compute(to_jsonb(x)) c
    left join public.pnl_grades p on p.sig_key = c.sig_key
    where x.flagged_at is not null and c.sig_key is not null;
  if p_commit then
    for r in select b.src from pnl_bf b where b.action <> 'unchanged' order by b.sig_key loop
      w := public.pnl_grade_write(r.src, 'backfill');
      if w = 'inserted' then ins := ins + 1; elsif w = 'updated' then upd := upd + 1; end if;
    end loop;
  end if;
  return query
  select q.* from (
  select 'mode' sec, 1 ln, null::text, case when p_commit then format('WRITTEN: %s inserted, %s updated, %s already correct', ins, upd, (select count(*) from pnl_bf where action = 'unchanged'))
    else 'DRY RUN: nothing was written. To write exactly this: select * from public.pnl_backfill(true);' end, null, null, null, null, null
  union all
  select 'counts', o, null, k, null, null, null, null, v::text from (values
    (1, 'flags that reached their close or settlement', (select count(*) from pnl_bf)),
    (2, case when p_commit then 'were new' else 'would insert' end, (select count(*) from pnl_bf where action = 'insert')),
    (3, case when p_commit then 'were rewritten' else 'would update' end, (select count(*) from pnl_bf where action = 'update')),
    (4, 'already correct', (select count(*) from pnl_bf where action = 'unchanged')),
    (5, 'graded (win, loss or push at a real flag price)', (select count(*) from pnl_bf where pnl_status = 'graded')),
    (6, 'void / cancelled (not a bet)', (select count(*) from pnl_bf where pnl_status = 'void')),
    (7, 'ungraded: no valid flag price', (select count(*) from pnl_bf where pnl_status = 'ungraded_missing_price')),
    (8, 'ungraded: waiting on a result', (select count(*) from pnl_bf where pnl_status = 'ungraded_unsettled')),
    (9, 'outside the 0.5-10% edge band (kept, not in the record)', (select count(*) from pnl_bf where record_scope <> 'record'))) t(o, k, v)
  union all
  select 'sample', (row_number() over (order by z.game_date, z.sig_key))::int, coalesce(z.sport_title, z.sport_key),
    coalesce(z.away_team || ' @ ' || z.home_team, z.event_id) || ' · ' || z.game_date,
    z.selection || coalesce(' ' || case when z.market_type = 'spread' and z.point > 0 then '+' else '' end || trim_scale(z.point)::text, '') || ' (' || z.market_type || ')',
    public.pnl_fmt_price(z.price_at_flag_dec), coalesce(z.result, z.result_raw, 'pending'), public.pnl_fmt_units(z.pnl_units),
    z.pnl_status || coalesce(' (' || z.ungraded_reason || ')', '') || ' · tier ' || z.tier || case when z.record_scope <> 'record' then ' · outside edge band' else '' end
  from (select y.* from (select b.*, row_number() over (partition by b.pnl_status order by md5(b.sig_key)) rn from pnl_bf b) y
        where y.rn <= case when y.pnl_status = 'graded' then 20 else 3 end
        order by (y.pnl_status = 'graded'), y.rn limit 20) z
  union all
  select 'totals', (row_number() over (order by t.sp is null, t.sp))::int, coalesce(t.sp, 'ALL SPORTS'),
    format('graded %s · %s-%s-%s', t.g, t.w, t.l, t.p), null, null, null, public.pnl_fmt_units(t.u),
    format('ROI %s · void %s · no flag price %s · waiting on a result %s · outside edge band %s',
      coalesce(to_char(round(t.u / nullif(t.w + t.l, 0) * 100, 1), 'FMS9990.0') || '%', '—'), t.v, t.m, t.un, t.o)
  from (select coalesce(b.sport_title, b.sport_key, '?') sp,
          count(*) filter (where gr) g, count(*) filter (where gr and b.result = 'win') w, count(*) filter (where gr and b.result = 'loss') l,
          count(*) filter (where gr and b.result = 'push') p, coalesce(sum(b.pnl_units) filter (where gr), 0) u,
          count(*) filter (where rec and b.pnl_status = 'void') v, count(*) filter (where rec and b.pnl_status = 'ungraded_missing_price') m,
          count(*) filter (where rec and b.pnl_status = 'ungraded_unsettled') un, count(*) filter (where not rec) o
        from (select pb.*, pb.record_scope = 'record' rec, pb.record_scope = 'record' and pb.pnl_status = 'graded' gr from pnl_bf pb) b
        group by rollup (coalesce(b.sport_title, b.sport_key, '?'))) t
  union all
  select 'check', v.n, null, v.check_name, null, null, null, v.got, v.status from public.pnl_verify() v where p_commit or v.n <= 5
  ) q order by array_position(array['mode', 'counts', 'sample', 'totals', 'check'], q.sec), q.ln;
end $b$;
revoke all on function public.pnl_backfill(boolean) from public, anon, authenticated;
grant execute on function public.pnl_backfill(boolean) to service_role;

revoke all on function public.pnl_verify() from public, anon, authenticated;
grant execute on function public.pnl_verify() to service_role;

notify pgrst, 'reload schema';

-- THE REPORT. Rows 1-4 should read ok; row 5 says what is left to do.
select n, piece, state from (
  select 1 as n, 'the settlement hook is on signals (update + insert)' as piece,
    case when (select count(*) from pg_trigger where tgrelid = 'public.signals'::regclass and tgname in ('pnl_signals_settle_trg', 'pnl_signals_insert_trg')) = 2 then 'ok' else 'CHECK THIS' end as state
  union all select 2, 'the hook can never fail a settlement (errors are caught and logged)',
    case when (select prosrc from pg_proc where oid = 'public.pnl_signals_sync()'::regprocedure) like '%exception when others%' then 'ok' else 'CHECK THIS' end
  union all select 3, 'the Records tab can read the reconciliation',
    case when has_function_privilege('authenticated', 'public.pnl_reconciliation()', 'execute') then 'ok' else 'CHECK THIS' end
  union all select 4, 'backfill and verify are service-role only',
    case when not has_function_privilege('anon', 'public.pnl_backfill(boolean)', 'execute') and not has_function_privilege('authenticated', 'public.pnl_backfill(boolean)', 'execute')
      and not has_function_privilege('anon', 'public.pnl_verify()', 'execute') then 'ok' else 'CHECK THIS' end
  union all select 5, 'history: flags that still need a P&L row',
    (select case when (rc ->> 'ok')::boolean then 'ok: nothing to backfill'
      else 'NEXT: ' || ((rc ->> 'settled_without_pnl')::int + (rc ->> 'closed_without_pnl')::int + (rc ->> 'out_of_sync')::int)
        || ' flags need the backfill. Run the dry run: select * from public.pnl_backfill();' end
     from (select public.pnl_reconciliation() rc) q)
) r order by 1;
