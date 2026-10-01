-- ============================================================================
-- EDGEDESK — pnl_grades, part 2 of 3: the verdict, the derivation, the
-- settlement hook and the backfill.
-- docs/pnl/GRADES.md. Run supabase/pnl_grades.sql first (the guard says so).
--
--   · pnl_grades_compute(signal) is the ONE derivation: the trigger, the
--     backfill and the dry run all read it, so they cannot disagree;
--   · the trigger on signals grades a flag in the same transaction that flags
--     or settles it. No cron, and nothing in capture, close or settle changes;
--   · pnl_grades_backfill(false) is the dry run: it writes nothing and prints
--     the counts, a 20-row sample and the totals per sport. (true) commits.
--     Run it as often as you like: a second run inserts and updates nothing;
--   · pnl_reconciliation() (in pnl_grades_analytics.sql) checks it all.
-- Idempotent and additive. Ends in a report whose rows must all read ok.
-- ============================================================================

do $dep$ begin
  if to_regclass('public.pnl_grades') is null or to_regprocedure('public.pnl_profit_decimal(numeric,text)') is null then
    raise exception 'pnl_grades_sync.sql builds on public.pnl_grades: run supabase/pnl_grades.sql first';
  end if;
end $dep$;

-- The board's verdict for a capture-qualified row (app.html, the deterministic
-- verdict), on the inputs frozen at the flag. Books = flagged_fresh_books, the
-- only book count frozen then (never more than the total, so it never makes a
-- BET easier to reach).
create or replace function public.pnl_verdict_at_flag(p_tier text, p_edge numeric, p_book text, p_books integer,
  p_reference text, out verdict text, out reason text)
language plpgsql immutable as $f$
declare us boolean := public.pnl_trusted_book(p_book); nb integer := coalesce(p_books, 0);
begin
  if p_tier is null then
    verdict := 'UNLABELLED'; reason := 'Flagged before capture froze a qualification tier, so its BET/LEAN label cannot be rebuilt.';
  elsif p_tier not in ('A', 'B') then
    verdict := 'PASS'; reason := 'Capture froze tier ' || p_tier || ', which is not an actionable tier.';
  elsif p_edge is null or p_edge < 0.005 then
    verdict := 'PASS'; reason := 'The edge at the flag was under the board''s 0.5% floor.';
  elsif not us and nb < 4 then
    verdict := 'PASS'; reason := 'Offshore best price with fewer than 4 books behind the fair line.';
  elsif p_tier = 'B' then
    verdict := 'LEAN'; reason := 'Fair price from a consensus of books, with no sharp reference.';
  elsif p_edge >= 0.03 and us and nb >= 5 and p_reference = 'sharp' then
    verdict := 'BET'; reason := 'Sharp-confirmed, 3%+ edge at a US-regulated book, 5+ books.';
  else
    verdict := 'LEAN';
    reason := case when p_edge < 0.03 then 'Sharp-anchored, but the edge was under 3%.'
                   when not us then 'The best price was at an offshore book.'
                   when nb < 5 then 'Fewer than 5 books behind the fair line.'
                   else 'No sharp reference on this exact side.' end;
  end if;
end $f$;

-- ONE derivation: a signals row in, its P&L row out. Writes nothing.
create or replace function public.pnl_grades_compute(s public.signals) returns public.pnl_grades
language plpgsql stable as $f$
declare g public.pnl_grades; v record; res text := public.pnl_norm_result(s.result);
begin
  g.sig_key := s.sig_key; g.sport_key := s.sport_key; g.sport_title := s.sport_title; g.event_id := s.event_id;
  g.event_label := nullif(concat_ws(' @ ', nullif(s.away_team, ''), nullif(s.home_team, '')), '');
  g.event_at := s.commence_time; g.market := s.market; g.market_type := public.pnl_market_type(s.market);
  g.selection := s.selection; g.point := s.point; g.participant := to_jsonb(s) ->> 'participant';
  g.flagged_at := s.flagged_at; g.flagged_book := s.flagged_best_book; g.flagged_tier := s.flagged_tier;
  g.flagged_edge := s.flagged_edge; g.flagged_reference_type := s.flagged_reference_type;
  g.flagged_fresh_books := s.flagged_fresh_books; g.flagged_policy := s.flagged_policy;
  select * into v from public.pnl_verdict_at_flag(s.flagged_tier, s.flagged_edge, s.flagged_best_book, s.flagged_fresh_books, s.flagged_reference_type);
  g.verdict := v.verdict; g.verdict_reason := v.reason;
  g.stake_units := case when g.verdict = 'PASS' then 0 else 1 end;
  g.price_at_flag := case when s.flagged_best_dec > 1 then s.flagged_best_dec end;
  g.price_at_flag_american := public.pnl_american(g.price_at_flag);
  g.price_at_close := case when s.closing_dec > 1 then s.closing_dec end;
  g.price_at_close_american := public.pnl_american(g.price_at_close);
  g.result := case when res in ('win', 'loss', 'push', 'void') then res end;
  g.settled_at := case when g.result is not null then s.graded_at end;
  if g.verdict = 'PASS' then
    g.pnl_status := 'not_a_bet'; g.pnl_reason := 'pass_at_flag';
  elsif g.result = 'void' then
    g.pnl_status := 'void'; g.pnl_reason := 'void_no_action';
  elsif g.result is null then
    g.pnl_status := 'ungraded_unsettled';
    g.pnl_reason := case when res is null then 'awaiting_result' when res = 'pending' then 'result_pending' else 'unrecognised_result' end;
  elsif s.sport_key like 'tennis%' and s.market in ('spreads', 'totals', 'alternate_spreads', 'alternate_totals') then
    g.pnl_status := 'ungraded_unsupported'; g.pnl_reason := 'tennis_line_settled_in_sets_not_games';
  elsif g.price_at_flag is null then
    g.pnl_status := 'ungraded_missing_price';
    g.pnl_reason := case when s.flagged_best_dec is null then 'no_flag_price' else 'invalid_flag_price' end;
  else
    g.pnl_status := 'graded';
    g.pnl_units := public.pnl_profit_decimal(g.price_at_flag, g.result);
    g.pnl_units_at_close := public.pnl_profit_decimal(g.price_at_close, g.result);
  end if;
  g.calc_version := public.pnl_calc_version(); g.computed_at := now(); g.created_at := now();
  return g;
end $f$;

-- The one writer: insert, update what moved, leave the rest.
create or replace function public.pnl_grades_write(c public.pnl_grades) returns text
language plpgsql security definer set search_path = public as $f$
declare e public.pnl_grades;
begin
  select * into e from public.pnl_grades where sig_key = c.sig_key for update;
  if not found then
    insert into public.pnl_grades select (c).* on conflict (sig_key) do nothing;
    if found then return 'inserted'; end if;
    select * into e from public.pnl_grades where sig_key = c.sig_key for update;
  end if;
  if (to_jsonb(e) - 'computed_at' - 'created_at') = (to_jsonb(c) - 'computed_at' - 'created_at') then return 'unchanged'; end if;
  update public.pnl_grades set
    (sport_key, sport_title, event_id, event_label, event_at, market, market_type, selection, point, participant,
     flagged_at, flagged_book, flagged_tier, flagged_edge, flagged_reference_type, flagged_fresh_books, flagged_policy,
     verdict, verdict_reason, stake_units, price_at_flag, price_at_close, result, settled_at, pnl_status, pnl_reason, calc_version)
  = (c.sport_key, c.sport_title, c.event_id, c.event_label, c.event_at, c.market, c.market_type, c.selection, c.point, c.participant,
     c.flagged_at, c.flagged_book, c.flagged_tier, c.flagged_edge, c.flagged_reference_type, c.flagged_fresh_books, c.flagged_policy,
     c.verdict, c.verdict_reason, c.stake_units, c.price_at_flag, c.price_at_close, c.result, c.settled_at, c.pnl_status, c.pnl_reason, c.calc_version)
  where sig_key = c.sig_key;
  return 'updated';
end $f$;

-- The hook: grades a flag in the same transaction that flags or settles it.
-- A P&L fault never fails the signals write; it is logged and reconciled.
create or replace function public.pnl_grades_on_signal() returns trigger
language plpgsql security definer set search_path = public as $f$
begin
  begin
    perform public.pnl_grades_write(public.pnl_grades_compute(new));
  exception when others then
    begin
      insert into public.pnl_grades_errors (sig_key, sqlstate, message) values (new.sig_key, sqlstate, sqlerrm);
    exception when others then
      raise warning 'pnl_grades: could not grade % (%)', new.sig_key, sqlerrm;
    end;
  end;
  return null;
end $f$;
drop trigger if exists pnl_grades_on_signal_ins_trg on public.signals;
create trigger pnl_grades_on_signal_ins_trg after insert on public.signals
  for each row when (new.flagged_at is not null) execute function public.pnl_grades_on_signal();
drop trigger if exists pnl_grades_on_signal_upd_trg on public.signals;
create trigger pnl_grades_on_signal_upd_trg after update on public.signals
  for each row when (new.flagged_at is not null and (old.flagged_at is null
    or (new.flagged_best_dec, new.result, new.graded_at, new.closing_dec, new.commence_time, new.flagged_tier)
       is distinct from (old.flagged_best_dec, old.result, old.graded_at, old.closing_dec, old.commence_time, old.flagged_tier)))
  execute function public.pnl_grades_on_signal();

-- display helpers for the backfill report (and anyone reading the table by hand)
create or replace function public.pnl_price_text(p_dec numeric) returns text
language sql immutable as $f$
  select case when p_dec is null or not (p_dec > 1) then 'no price'
    else (case when public.pnl_american(p_dec) > 0 then '+' else '' end) || round(public.pnl_american(p_dec))::text
         || ' (' || trim_scale(p_dec)::text || ')' end
$f$;
create or replace function public.pnl_side(p_participant text, p_selection text, p_point numeric, p_market_type text) returns text
language sql immutable as $f$
  select concat_ws(' ', nullif(p_participant, ''), coalesce(p_selection, '?'),
    case when p_point is null then null when p_market_type = 'spread' and p_point > 0 then '+' || trim_scale(p_point)::text
         else trim_scale(p_point)::text end)
$f$;
-- W-L-P and ROI over a group, as one string
create or replace function public.pnl_wlp_step(s numeric[], p_result text, p_status text, p_units numeric, p_stake numeric) returns numeric[]
language sql immutable as $f$
  select case when p_status = 'graded' then array[
    s[1] + (p_result = 'win')::int, s[2] + (p_result = 'loss')::int, s[3] + (p_result = 'push')::int, s[4] + p_units, s[5] + p_stake] else s end
$f$;
create or replace function public.pnl_wlp_final(s numeric[]) returns text
language sql immutable as $f$
  select s[1]::int || '-' || s[2]::int || '-' || s[3]::int
    || case when s[5] > 0 then ' · ROI ' || to_char(round(100 * s[4] / s[5], 2), 'FMS9990.00') || '%' else '' end
$f$;
do $agg$ begin
  if to_regprocedure('public.pnl_wlp(text,text,numeric,numeric)') is null then
    create aggregate public.pnl_wlp(text, text, numeric, numeric) (
      sfunc = public.pnl_wlp_step, stype = numeric[], finalfunc = public.pnl_wlp_final, initcond = '{0,0,0,0,0}');
  end if;
end $agg$;

-- The history. Dry run (false) writes nothing; commit (true) upserts. Either
-- way it prints what it found. Safe to repeat: a second commit changes nothing.
create or replace function public.pnl_grades_backfill(p_commit boolean default false)
returns table (section text, item text, detail text, n bigint, units numeric)
language plpgsql security definer set search_path = public as $f$
declare g public.pnl_grades; o text; ins bigint := 0; upd bigint := 0; same bigint := 0; bad bigint := 0;
begin
  create temp table if not exists pnl_backfill_rows (like public.pnl_grades) on commit drop;
  truncate pnl_backfill_rows;
  insert into pnl_backfill_rows select (public.pnl_grades_compute(s)).* from public.signals s where s.flagged_at is not null;
  if p_commit then
    for g in select * from pnl_backfill_rows order by flagged_at, sig_key loop
      begin
        o := public.pnl_grades_write(g);
        if o = 'inserted' then ins := ins + 1; elsif o = 'updated' then upd := upd + 1; else same := same + 1; end if;
      exception when others then
        bad := bad + 1;
        insert into public.pnl_grades_errors (sig_key, sqlstate, message) values (g.sig_key, sqlstate, sqlerrm);
      end;
    end loop;
  else
    select count(*) filter (where e.sig_key is null),
           count(*) filter (where e.sig_key is not null and (to_jsonb(e) - 'computed_at' - 'created_at') <> (to_jsonb(b) - 'computed_at' - 'created_at')),
           count(*) filter (where e.sig_key is not null and (to_jsonb(e) - 'computed_at' - 'created_at') = (to_jsonb(b) - 'computed_at' - 'created_at'))
      into ins, upd, same
      from pnl_backfill_rows b left join public.pnl_grades e on e.sig_key = b.sig_key;
  end if;

  return query select 'mode'::text, case when p_commit then 'COMMITTED' else 'DRY RUN: nothing was written' end,
    'calc_version ' || public.pnl_calc_version(), (select count(*) from pnl_backfill_rows), null::numeric;
  return query select 'rows', x.k, null::text, x.v, null::numeric from (values
    (1, case when p_commit then 'inserted' else 'would insert' end, ins), (2, case when p_commit then 'updated' else 'would update' end, upd),
    (3, 'unchanged', same), (4, 'errors (see pnl_grades_errors)', bad)) x(o, k, v) order by x.o;
  return query select 'status', b.pnl_status, coalesce(b.pnl_reason, ''), count(*), round(sum(b.pnl_units), 2)
    from pnl_backfill_rows b group by b.pnl_status, b.pnl_reason order by b.pnl_status, b.pnl_reason;
  return query select 'verdict', b.verdict, public.pnl_wlp(b.result, b.pnl_status, b.pnl_units, b.stake_units),
    count(*) filter (where b.pnl_status = 'graded'), round(coalesce(sum(b.pnl_units), 0), 2)
    from pnl_backfill_rows b group by b.verdict order by b.verdict;
  return query select 'sport', coalesce(b.sport_title, b.sport_key, 'unknown'), public.pnl_wlp(b.result, b.pnl_status, b.pnl_units, b.stake_units),
    count(*) filter (where b.pnl_status = 'graded'), round(coalesce(sum(b.pnl_units), 0), 2)
    from pnl_backfill_rows b group by 2 order by 2;
  return query select 'total', 'every graded flag', public.pnl_wlp(b.result, b.pnl_status, b.pnl_units, b.stake_units),
    count(*) filter (where b.pnl_status = 'graded'), round(coalesce(sum(b.pnl_units), 0), 2) from pnl_backfill_rows b;
  return query select 'sample', coalesce(b.event_label, b.event_id),
    b.verdict || ' · ' || public.pnl_side(b.participant, b.selection, b.point, b.market_type) || ' @ '
      || public.pnl_price_text(b.price_at_flag) || ' → ' || b.result,
    1::bigint, round(b.pnl_units, 4)
    from pnl_backfill_rows b where b.pnl_status = 'graded' order by md5(b.sig_key) limit 20;
end $f$;

revoke all on function public.pnl_grades_write(public.pnl_grades) from public, anon, authenticated, service_role;
revoke all on function public.pnl_grades_compute(public.signals) from public, anon, authenticated;
revoke all on function public.pnl_grades_backfill(boolean) from public, anon, authenticated;
grant execute on function public.pnl_grades_backfill(boolean) to service_role;

notify pgrst, 'reload schema';

-- THE REPORT.
select piece, state from (
  select 'settlement hook: two triggers on signals' as piece,
    case when (select count(*) from pg_trigger where tgrelid = 'public.signals'::regclass
      and tgname in ('pnl_grades_on_signal_ins_trg', 'pnl_grades_on_signal_upd_trg')) = 2 then 'ok' else 'CHECK THIS' end as state
  union all select 'verdict at flag: A sharp 3.5% US 6 books BET; A 2% LEAN; B LEAN; offshore thin PASS; no tier UNLABELLED',
    case when (public.pnl_verdict_at_flag('A', 0.035, 'DraftKings', 6, 'sharp')).verdict = 'BET'
          and (public.pnl_verdict_at_flag('A', 0.02, 'DraftKings', 6, 'sharp')).verdict = 'LEAN'
          and (public.pnl_verdict_at_flag('B', 0.05, 'FanDuel', 9, 'robust_consensus')).verdict = 'LEAN'
          and (public.pnl_verdict_at_flag('A', 0.04, 'Bovada', 3, 'sharp')).verdict = 'PASS'
          and (public.pnl_verdict_at_flag(null, 0.04, 'DraftKings', 6, null)).verdict = 'UNLABELLED' then 'ok' else 'CHECK THIS' end
  union all select 'the backfill is the service role''s alone',
    case when not has_function_privilege('anon', 'public.pnl_grades_backfill(boolean)', 'execute')
          and not has_function_privilege('authenticated', 'public.pnl_grades_backfill(boolean)', 'execute')
          and has_function_privilege('service_role', 'public.pnl_grades_backfill(boolean)', 'execute')
          and not has_function_privilege('service_role', 'public.pnl_grades_write(public.pnl_grades)', 'execute') then 'ok' else 'CHECK THIS' end
) r order by 1;
