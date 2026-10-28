-- =============================================================================
-- bet_checker.sql — Bet Checker v1: the bets a reader already placed, graded
-- against EdgeDesk's own fair price at entry and its own captured close.
-- docs/bet-checker.md
--
-- NO PICKS. Bet Checker never says what to bet. It measures a price the reader
-- already took, twice: against EdgeDesk's fair price at the moment it is logged
-- (the ENTRY GRADE: green / yellow / red), and against EdgeDesk's captured
-- close (CLV), with the result once the game settles. Where the pipeline does
-- not own the number — no fair at that exact line, a close at a different line
-- — it says so and grades nothing. Nothing is interpolated or estimated.
--
-- WHAT IT BUILDS ON (nothing here is a second copy of something that exists):
--   public.user_bets       bettor_decisions.sql's table of bets the reader
--                          says they placed. Bet Checker rows are user_bets
--                          rows that name a board event (event_id); its
--                          entry and close columns are added here. The
--                          existing columns are reused: market_type (spread |
--                          total | moneyline), side (home | away | over |
--                          under), line, odds (American), book, units (the
--                          stake in units, default 1 here), placed_at,
--                          close_line, close_odds, result (NULL = pending),
--                          units_won, graded_at. The view bet_checker_bets
--                          shows them under Bet Checker's names.
--   public.signals         capture's board: one row per event x market x
--                          selection x line (sig_key). sharp_fair is THE fair
--                          probability EdgeDesk anchors on for that exact line;
--                          close writes closing_sharp_fair, clv_excluded_reason
--                          and closed_at on the same row. There is no events
--                          table: a game is signals.event_id, and a bet's
--                          event is checked against signals by trigger.
--   the house CLV          close/index.ts decideClose(): entry decimal x the
--                          no-vig closing probability - 1, at the SAME line.
--   has_bet_checker_paid() billing_hardening.sql: red (Bet Checker) or blue
--                          (Research Terminal) in good standing. Every paid
--                          gate below calls it.
--
-- THE RULES live in ONE constant, bet_checker_rules().
--
-- WHO WRITES WHAT
--   the reader     inserts and deletes their own rows (RLS), and may change
--                  only notes and void status (bettor_decisions.sql's column
--                  grant). A row a reader inserts directly carries no grade:
--                  every grading column is reset by trigger.
--   log_user_bet   (edge function, service role) calls bet_checker_log_bet():
--                  checks, the free allowance, the fair lookup and the grade,
--                  in ONE transaction.
--   grade_user_bets (edge function, service role, pg_cron after close) calls
--                  bet_checker_grade_pending(): close, CLV, result, the flag.
--
-- REQUIRES bettor_decisions.sql (user_bets), billing_hardening.sql
-- (has_bet_checker_paid) and capture's public.signals. Optional, used when
-- present: signal_pnl.sql's pnl_result() (settle's words), and the Collective's
-- football settlement (collective.fg2_event_links, fg2_src_games,
-- fg2_game_state) for final scores.
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- Mirrored byte for byte in migrations/20261028120000_bet_checker.sql.
-- =============================================================================

do $req$
declare missing text;
begin
  if to_regclass('public.user_bets') is null then
    raise exception 'bet_checker.sql extends public.user_bets: apply supabase/bettor_decisions.sql first';
  end if;
  if to_regprocedure('public.has_bet_checker_paid(uuid,timestamptz)') is null then
    raise exception 'bet_checker.sql needs public.has_bet_checker_paid(): apply supabase/billing_hardening.sql first';
  end if;
  if to_regclass('public.signals') is null then
    raise exception 'bet_checker.sql reads public.signals (capture''s board), which does not exist here';
  end if;
  select string_agg(c, ', ') into missing
    from unnest(array['sig_key', 'event_id', 'sport_key', 'commence_time', 'home_team', 'away_team', 'market', 'selection',
                      'point', 'sharp_fair', 'last_seen_at', 'point_is_modal', 'is_player_prop', 'flagged_at', 'closed_at',
                      'closing_sharp_fair', 'clv_excluded_reason', 'result']) c
   where not exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'signals' and column_name = c);
  if missing is not null then
    raise exception 'bet_checker.sql: public.signals has no column(s) % (capture / close write them)', missing;
  end if;
end
$req$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. THE RULES — one constant
-- ─────────────────────────────────────────────────────────────────────────────
-- edge_pct is the reader's edge in implied-probability points: EdgeDesk's fair
-- probability for the side minus the probability the reader's odds imply.
--   green  edge >= green_min_edge_pct
--   red    edge <= red_max_edge_pct
--   yellow anything between
-- A fair older than fair_max_age_min is not "our current fair price" (capture
-- refreshes every game at least every six hours). A month is a calendar month
-- in month_tz. A close not captured within no_close_after_hours of kickoff
-- never will be.
create or replace function public.bet_checker_rules()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'version',               'bet-checker-v1',
    'green_min_edge_pct',    1.5,
    'red_max_edge_pct',      -1.5,
    'free_monthly_grades',   10,
    'free_history_days',     30,
    'fair_max_age_min',      390,
    'month_tz',              'America/New_York',
    'no_close_after_hours',  24,
    'board_days_ahead',      14,
    'books',                 jsonb_build_array('Kalshi', 'DK Predictions', 'DraftKings', 'Other'),
    'sports',                jsonb_build_object('americanfootball_nfl', 'NFL', 'americanfootball_ncaaf', 'CFB'));
$$;

-- the arithmetic, once
create or replace function public.bet_checker_implied_prob(p_american numeric)
returns numeric language sql immutable as $$
  select case when p_american is null or abs(p_american) < 100 then null
              when p_american > 0 then 100 / (p_american + 100)
              else -p_american / (-p_american + 100) end;
$$;
create or replace function public.bet_checker_decimal(p_american numeric)
returns numeric language sql immutable as $$
  select case when p_american is null or abs(p_american) < 100 then null
              when p_american > 0 then 1 + p_american / 100
              else 1 + 100 / -p_american end;
$$;
-- a probability as American odds, rounded to a whole number (display only:
-- every computation keeps the probability itself)
create or replace function public.bet_checker_prob_to_american(p numeric)
returns integer language sql immutable as $$
  select case when p is null or p <= 0 or p >= 1 then null
              when p >= 0.5 then -round(100 * p / (1 - p))::integer
              else round(100 * (1 - p) / p)::integer end;
$$;
create or replace function public.bet_checker_grade_of(p_edge_pct numeric)
returns text language sql immutable as $$
  select case when p_edge_pct is null then 'ungraded'
              when p_edge_pct >= (public.bet_checker_rules() ->> 'green_min_edge_pct')::numeric then 'green'
              when p_edge_pct <= (public.bet_checker_rules() ->> 'red_max_edge_pct')::numeric then 'red'
              else 'yellow' end;
$$;
create or replace function public.bet_checker_month_start(p_at timestamptz default now())
returns date language sql stable as $$
  select date_trunc('month', p_at at time zone (public.bet_checker_rules() ->> 'month_tz'))::date;
$$;
-- the board's words for a bet's market and side
create or replace function public.bet_checker_board_market(p_market_type text)
returns text language sql immutable as $$
  select case p_market_type when 'spread' then 'spreads' when 'total' then 'totals' when 'moneyline' then 'h2h' end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. user_bets GAINS THE ENTRY AND THE CLOSE
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.user_bets add column if not exists event_id            text;
alter table public.user_bets add column if not exists entry_sig_key       text;
alter table public.user_bets add column if not exists entry_fair_price    integer;
alter table public.user_bets add column if not exists entry_fair_prob     numeric;
alter table public.user_bets add column if not exists entry_fair_seen_at  timestamptz;
alter table public.user_bets add column if not exists entry_edge_pct      numeric;
alter table public.user_bets add column if not exists entry_grade         text;
alter table public.user_bets add column if not exists entry_grade_reason  text;
alter table public.user_bets add column if not exists close_status        text;
alter table public.user_bets add column if not exists close_reason        text;
alter table public.user_bets add column if not exists close_fair_prob     numeric;
alter table public.user_bets add column if not exists clv_pct             numeric;
alter table public.user_bets add column if not exists close_checked_at    timestamptz;
alter table public.user_bets add column if not exists result_source       text;
alter table public.user_bets add column if not exists edgedesk_flagged    boolean not null default false;
alter table public.user_bets add column if not exists flagged_signal_id   text;
alter table public.user_bets add column if not exists flag_checked_at     timestamptz;
alter table public.user_bets add column if not exists updated_at          timestamptz not null default now();
alter table public.user_bets alter column units set default 1;

comment on column public.user_bets.event_id is 'Bet Checker: the board event (public.signals.event_id). NULL on a bet recorded from the decision card.';
comment on column public.user_bets.entry_fair_price is 'EdgeDesk''s fair price for this exact market, side and line when the bet was logged, as American odds. Frozen: never recomputed.';
comment on column public.user_bets.entry_fair_prob is 'The same fair as a probability (signals.sharp_fair), the number every computation uses.';
comment on column public.user_bets.entry_edge_pct is 'Fair probability minus the probability the reader''s odds imply, in points. + = the reader beat EdgeDesk''s fair.';
comment on column public.user_bets.entry_grade is 'green | yellow | red, by the edge thresholds in bet_checker_rules() | ungraded (entry_grade_reason says why).';
comment on column public.user_bets.close_status is 'pending | captured | no_close_available (close_reason says why). Captured only at the bet''s own line.';
comment on column public.user_bets.clv_pct is 'House CLV (close/index.ts): the reader''s decimal odds x EdgeDesk''s no-vig closing probability - 1, in percent. + = beat the close.';
comment on column public.user_bets.edgedesk_flagged is 'An EdgeDesk signal on the same event, market and side was flagged before this bet was logged. Revealed once the game starts.';

do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'user_bets_entry_grade_check') then
    alter table public.user_bets add constraint user_bets_entry_grade_check
      check (entry_grade is null or entry_grade in ('green', 'yellow', 'red', 'ungraded'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'user_bets_close_status_check') then
    alter table public.user_bets add constraint user_bets_close_status_check
      check (close_status is null or close_status in ('pending', 'captured', 'no_close_available'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'user_bets_entry_fair_prob_check') then
    alter table public.user_bets add constraint user_bets_entry_fair_prob_check
      check (entry_fair_prob is null or (entry_fair_prob > 0 and entry_fair_prob < 1));
  end if;
  -- the owner is a real account. NOT VALID first so a stray historical row can
  -- never stop this file; every new row is checked, and the old ones are
  -- validated when they all pass (the report says which).
  if not exists (select 1 from pg_constraint where conname = 'user_bets_user_fk') then
    alter table public.user_bets add constraint user_bets_user_fk
      foreign key (user_id) references auth.users (id) on delete cascade not valid;
  end if;
  begin
    alter table public.user_bets validate constraint user_bets_user_fk;
  exception when others then
    raise notice 'user_bets_user_fk left NOT VALID: %', sqlerrm;
  end;
  -- the flagged signal is a board row, when the board's key is unique (the
  -- signal_pnl.sql pattern: capture upserts on a unique sig_key)
  if not exists (select 1 from pg_constraint where conname = 'user_bets_flagged_signal_fk')
     and exists (select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
                  where i.indrelid = 'public.signals'::regclass and i.indisunique and i.indnatts = 1 and i.indpred is null
                    and a.attname = 'sig_key') then
    alter table public.user_bets add constraint user_bets_flagged_signal_fk
      foreign key (flagged_signal_id) references public.signals (sig_key) on delete set null;
  end if;
end
$c$;

create index if not exists user_bets_event_market_idx on public.user_bets (event_id, market_type) where event_id is not null;
create index if not exists user_bets_bc_pending_idx on public.user_bets (kickoff)
  where event_id is not null and (close_status = 'pending' or result is null or flag_checked_at is null);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. THE GRADING COLUMNS ARE THE SERVICE ROLE'S
-- ─────────────────────────────────────────────────────────────────────────────
-- UPDATE: bettor_decisions.sql grants a reader update on (notes, status) only,
-- so no column added here is writable by a reader at all. INSERT: a reader's
-- own insert keeps its placement facts and loses every grading column — the
-- same pattern as user_bets_on_insert() for close_line and result. Either way,
-- a Bet Checker row (event_id set) must name a real board event for NFL or
-- college football that has not started; its kickoff and teams are the board's.
-- WHO IS ASKING. The role the request runs as (PostgREST sets it: anon,
-- authenticated, service_role), not current_user, which inside a SECURITY
-- DEFINER function is the function's owner and would trust everybody. 'none'
-- is a direct connection: the SQL editor, pg_cron.
create or replace function public.bet_checker_trusted() returns boolean
language sql stable as $$
  select case coalesce(nullif(current_setting('role', true), ''), 'none')
           when 'service_role' then true
           when 'none' then current_user in ('postgres', 'supabase_admin', 'service_role')
           else false end;
$$;

create or replace function public.user_bets_bet_checker_insert() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare ev record; v_sport text;
begin
  if not public.bet_checker_trusted() then
    new.entry_sig_key := null; new.entry_fair_price := null; new.entry_fair_prob := null; new.entry_fair_seen_at := null;
    new.entry_edge_pct := null;
    new.entry_grade := case when new.event_id is not null then 'ungraded' end;
    new.entry_grade_reason := case when new.event_id is not null then 'not_logged_through_bet_checker' end;
    new.close_status := case when new.event_id is not null then 'pending' end;
    new.close_reason := null; new.close_fair_prob := null; new.clv_pct := null; new.close_checked_at := null;
    new.result_source := null; new.edgedesk_flagged := false; new.flagged_signal_id := null; new.flag_checked_at := null;
  end if;
  if new.event_id is not null then
    select s.sport_key, s.commence_time, s.home_team, s.away_team into ev
      from public.signals s
     where s.event_id = new.event_id and s.market in ('h2h', 'spreads', 'totals') and not coalesce(s.is_player_prop, false)
     order by s.last_seen_at desc nulls last limit 1;
    if not found then
      raise exception 'user_bets: event % is not on EdgeDesk''s board', new.event_id using errcode = 'foreign_key_violation';
    end if;
    v_sport := public.bet_checker_rules() -> 'sports' ->> ev.sport_key;
    if v_sport is null or v_sport is distinct from new.sport then
      raise exception 'user_bets: event % is not a % game', new.event_id, coalesce(new.sport, '?') using errcode = 'check_violation';
    end if;
    if ev.commence_time is null or ev.commence_time <= now() then
      raise exception 'user_bets: event % has already started', new.event_id using errcode = 'check_violation';
    end if;
    new.kickoff := ev.commence_time; new.home_team := ev.home_team; new.away_team := ev.away_team;
    if new.game_id is null then new.game_id := new.event_id; end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists user_bets_bet_checker_insert_trg on public.user_bets;
create trigger user_bets_bet_checker_insert_trg before insert on public.user_bets
  for each row execute function public.user_bets_bet_checker_insert();

create or replace function public.user_bets_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists user_bets_touch_trg on public.user_bets;
create trigger user_bets_touch_trg before update on public.user_bets
  for each row execute function public.user_bets_touch();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. THE FREE ALLOWANCE: every grade issued, append-only
-- ─────────────────────────────────────────────────────────────────────────────
-- Counted from this ledger, not from user_bets, so deleting a graded bet never
-- gives a grade back. `paid` says whether the grade was issued under a paid
-- plan; only free grades count against the free allowance.
create table if not exists public.bet_checker_grades (
  id           bigint generated always as identity primary key,
  user_id      uuid        not null references auth.users (id) on delete cascade,
  bet_id       uuid        references public.user_bets (id) on delete set null,
  graded_at    timestamptz not null default now(),
  month_start  date        not null,
  paid         boolean     not null,
  grade        text        not null check (grade in ('green', 'yellow', 'red'))
);
create index if not exists bet_checker_grades_month_idx on public.bet_checker_grades (user_id, month_start);
comment on table public.bet_checker_grades is
  'One row per entry grade Bet Checker issued. The free allowance counts this month''s free rows. Written only by bet_checker_log_bet().';
alter table public.bet_checker_grades enable row level security;
drop policy if exists bet_checker_grades_select_own on public.bet_checker_grades;
create policy bet_checker_grades_select_own on public.bet_checker_grades for select to authenticated using (user_id = auth.uid());
revoke all on public.bet_checker_grades from anon, authenticated;
grant select on public.bet_checker_grades to authenticated;

-- A reader's month. Any caller may ask about themselves; only the service role
-- may ask about somebody else.
create or replace function public.bet_checker_usage(p_user uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := coalesce(p_user, auth.uid());
  v_month date := public.bet_checker_month_start(now());
  v_limit int := (public.bet_checker_rules() ->> 'free_monthly_grades')::int;
  v_paid boolean; v_free int; v_all int;
begin
  if v_user is null then raise exception 'bet_checker: sign in first' using errcode = '42501'; end if;
  if auth.uid() is distinct from v_user and not public.bet_checker_trusted() then
    raise exception 'bet_checker: a reader may only read their own allowance' using errcode = '42501';
  end if;
  v_paid := public.has_bet_checker_paid(v_user, now());
  select count(*) filter (where not g.paid), count(*) into v_free, v_all
    from public.bet_checker_grades g where g.user_id = v_user and g.month_start = v_month;
  return jsonb_build_object('user_id', v_user, 'month_start', v_month, 'paid', v_paid,
    'graded_this_month', v_all, 'free_grades_used', v_free, 'free_limit', v_limit,
    'free_remaining', case when v_paid then null else greatest(v_limit - v_free, 0) end);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. THE BOARD THE FORM PICKS FROM (identity and lines, never a price)
-- ─────────────────────────────────────────────────────────────────────────────
-- Games that have not started, NFL and college football, the next two weeks.
create or replace function public.bet_checker_games(p_sport text default null)
returns table (event_id text, sport text, commence_time timestamptz, home_team text, away_team text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare r jsonb := public.bet_checker_rules();
begin
  if auth.uid() is null and not public.bet_checker_trusted() then
    raise exception 'bet_checker: sign in first' using errcode = '42501';
  end if;
  return query
    select q.event_id, (r -> 'sports' ->> q.sport_key)::text, q.commence_time, q.home_team, q.away_team
      from (select distinct on (s.event_id) s.event_id, s.sport_key, s.commence_time, s.home_team, s.away_team
              from public.signals s
             where s.market in ('h2h', 'spreads', 'totals') and not coalesce(s.is_player_prop, false)
               and s.sport_key in (select jsonb_object_keys(r -> 'sports'))
               -- the board's recent rows only (signals (sport_key, commence_time)
               -- serves it); a week back keeps a rescheduled game's newest row in
               -- view, and the newest row alone decides below
               and s.commence_time > now() - interval '7 days'
               and s.commence_time <= now() + make_interval(days => (r ->> 'board_days_ahead')::int)
               and s.event_id is not null and s.home_team is not null and s.away_team is not null
             order by s.event_id, s.last_seen_at desc nulls last) q
     where q.commence_time > now()
       and q.commence_time <= now() + make_interval(days => (r ->> 'board_days_ahead')::int)
       and (p_sport is null or (r -> 'sports' ->> q.sport_key) = upper(p_sport))
     order by q.commence_time, q.event_id
     limit 500;
end;
$$;

-- Every line the board carries for one game, as the reader would name it.
-- `priced`: EdgeDesk has a current fair price at exactly this line, so a bet
-- here can be graded; `modal`: the line most books are hanging.
create or replace function public.bet_checker_lines(p_event_id text)
returns table (market_type text, side text, team text, line numeric, modal boolean, priced boolean)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare r jsonb := public.bet_checker_rules();
begin
  if auth.uid() is null and not public.bet_checker_trusted() then
    raise exception 'bet_checker: sign in first' using errcode = '42501';
  end if;
  return query
    with ev as (
      select s.event_id, s.home_team, s.away_team, s.commence_time from public.signals s
       where s.event_id = p_event_id and s.market in ('h2h', 'spreads', 'totals') and not coalesce(s.is_player_prop, false)
       order by s.last_seen_at desc nulls last limit 1
    ), ln as (
      select case s.market when 'spreads' then 'spread' when 'totals' then 'total' when 'h2h' then 'moneyline' end as mt,
             case when s.market = 'totals' and lower(s.selection) = 'over' then 'over'
                  when s.market = 'totals' and lower(s.selection) = 'under' then 'under'
                  when s.market <> 'totals' and s.selection = ev.home_team then 'home'
                  when s.market <> 'totals' and s.selection = ev.away_team then 'away' end as sd,
             case when s.market <> 'totals' then s.selection end as tm,
             case when s.market = 'h2h' then null else s.point end as pt,
             coalesce(s.point_is_modal, false) as md,
             (s.sharp_fair > 0 and s.sharp_fair < 1
              and s.last_seen_at >= now() - make_interval(mins => (r ->> 'fair_max_age_min')::int)) as pr
        from public.signals s cross join ev
       where s.event_id = ev.event_id and ev.commence_time > now()
         and s.market in ('h2h', 'spreads', 'totals') and not coalesce(s.is_player_prop, false)
    )
    select mt, sd, max(tm), pt, bool_or(md), bool_or(coalesce(pr, false))
      from ln where mt is not null and sd is not null
     group by mt, sd, pt
     order by case mt when 'spread' then 1 when 'total' then 2 else 3 end, sd, pt;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. LOGGING A BET, AND ITS INSTANT GRADE (one transaction)
-- ─────────────────────────────────────────────────────────────────────────────
-- The steps, in order; every refusal is an answer ({ok:false, reason}), never
-- a half-written row:
--   1 the event is on the board, NFL or college football, and not started
--   2 the free allowance: a reader without a paid plan who has used this
--     month's free grades still has the bet SAVED, ungraded, with an upgrade
--     prompt (and EdgeDesk's fair is not looked up, so it cannot leak)
--   3 EdgeDesk's current fair for exactly this event, market, side and line —
--     stored as entry_fair_price / entry_fair_prob and never recomputed
--   4 the edge: fair probability - the probability the reader's odds imply
--   5 the grade, by bet_checker_rules()
--   6 no fair at that exact line, or one older than fair_max_age_min:
--     ungraded, with the reason. Never interpolated from a neighbouring line.
--   7 the flag (an EdgeDesk signal on the same side) is NOT read here: it is
--     settled by bet_checker_grade_pending() once the game starts, against
--     signals flagged before this bet was logged. Revealing it at logging time
--     would let a free account read EdgeDesk's live signals one bet at a time.
-- p_client_key makes a double submit one bet (bet_key = 'bc:' || key).
create or replace function public.bet_checker_log_bet(
  p_user uuid, p_event_id text, p_market text, p_side text, p_line numeric, p_odds integer,
  p_book text, p_units numeric, p_client_key text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r        jsonb := public.bet_checker_rules();
  v_key    text;
  v_book   text;
  v_units  numeric := coalesce(p_units, 1);
  v_line   numeric := p_line;
  v_bmkt   text;
  v_sel    text;
  v_sport  text;
  v_paid   boolean;
  v_used   int;
  v_limit  int := (r ->> 'free_monthly_grades')::int;
  v_month  date := public.bet_checker_month_start(now());
  v_grade  text;
  v_reason text;
  v_edge   numeric;
  v_upgrade boolean := false;
  v_sig    text;
  v_fair   numeric;
  v_seen   timestamptz;
  ev record; b public.user_bets%rowtype; v_id uuid;
begin
  if not public.bet_checker_trusted() then
    raise exception 'bet_checker_log_bet is the service role''s (log_user_bet)' using errcode = '42501';
  end if;
  if p_user is null or not exists (select 1 from auth.users where id = p_user) then
    return jsonb_build_object('ok', false, 'reason', 'no_such_user');
  end if;
  if p_client_key is null or p_client_key !~ '^[A-Za-z0-9_-]{8,64}$' then
    return jsonb_build_object('ok', false, 'reason', 'bad_input', 'message', 'A client key is required.');
  end if;
  v_key := 'bc:' || p_client_key;

  -- a double submit is the same bet, answered again
  select * into b from public.user_bets where user_id = p_user and bet_key = v_key;
  if found then
    return jsonb_build_object('ok', true, 'replay', true, 'bet', to_jsonb(b) - 'recommendation',
      'usage', public.bet_checker_usage(p_user), 'upgrade', coalesce(b.entry_grade_reason = 'free_limit_reached', false));
  end if;

  -- the shape of the bet
  if p_market not in ('spread', 'total', 'moneyline') then
    return jsonb_build_object('ok', false, 'reason', 'bad_input', 'message', 'Market must be spread, total or moneyline.');
  end if;
  if (p_market = 'total' and p_side not in ('over', 'under')) or (p_market <> 'total' and p_side not in ('home', 'away')) then
    return jsonb_build_object('ok', false, 'reason', 'bad_input', 'message', 'That side does not belong to that market.');
  end if;
  if p_market = 'moneyline' then v_line := null;
  elsif v_line is null or abs(v_line) > 400 or (p_market = 'total' and v_line <= 0) then
    return jsonb_build_object('ok', false, 'reason', 'bad_input', 'message', 'A spread or total needs its line.');
  end if;
  if p_odds is null or abs(p_odds) < 100 or abs(p_odds) > 100000 then
    return jsonb_build_object('ok', false, 'reason', 'bad_input', 'message', 'Odds are American: -110, +150 …');
  end if;
  if v_units <= 0 or v_units > 100 then
    return jsonb_build_object('ok', false, 'reason', 'bad_input', 'message', 'Stake is between 0 and 100 units.');
  end if;
  select x into v_book from jsonb_array_elements_text(r -> 'books') x where lower(x) = lower(btrim(coalesce(p_book, '')));
  if v_book is null then
    return jsonb_build_object('ok', false, 'reason', 'bad_input', 'message', 'Book must be Kalshi, DK Predictions, DraftKings or Other.');
  end if;

  -- 1. the event: on the board, a sport Bet Checker grades, not started
  select s.sport_key, s.commence_time, s.home_team, s.away_team into ev
    from public.signals s
   where s.event_id = p_event_id and s.market in ('h2h', 'spreads', 'totals') and not coalesce(s.is_player_prop, false)
   order by s.last_seen_at desc nulls last limit 1;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_such_game', 'message', 'That game is not on EdgeDesk''s board.'); end if;
  v_sport := r -> 'sports' ->> ev.sport_key;
  if v_sport is null then return jsonb_build_object('ok', false, 'reason', 'not_graded_sport', 'message', 'Bet Checker grades NFL and college football.'); end if;
  if ev.commence_time is null or ev.commence_time <= now() then
    return jsonb_build_object('ok', false, 'reason', 'game_started', 'message', 'That game has started. Bet Checker grades bets logged before kickoff.');
  end if;
  v_bmkt := public.bet_checker_board_market(p_market);
  v_sel := case p_side when 'home' then ev.home_team when 'away' then ev.away_team when 'over' then 'Over' when 'under' then 'Under' end;

  -- 2. the free allowance, under a per-reader lock so two submits cannot both
  --    take the last free grade
  v_paid := public.has_bet_checker_paid(p_user, now());
  if not v_paid then
    perform pg_advisory_xact_lock(hashtextextended('bet_checker:' || p_user::text, 0));
    select count(*) into v_used from public.bet_checker_grades g
     where g.user_id = p_user and g.month_start = v_month and not g.paid;
    if v_used >= v_limit then
      v_grade := 'ungraded'; v_reason := 'free_limit_reached'; v_upgrade := true;
    end if;
  end if;

  -- 3-6. EdgeDesk's current fair at EXACTLY this line, or no grade
  if v_grade is null then
    select s.sig_key, s.sharp_fair, s.last_seen_at into v_sig, v_fair, v_seen
      from public.signals s
     where s.event_id = p_event_id and s.market = v_bmkt and s.selection = v_sel
       and s.point is not distinct from v_line and not coalesce(s.is_player_prop, false)
     order by s.last_seen_at desc nulls last limit 1;
    if v_sig is null or v_fair is null or not (v_fair > 0 and v_fair < 1) then
      v_grade := 'ungraded'; v_reason := 'no_fair_price_at_line';
    elsif v_seen is null or v_seen < now() - make_interval(mins => (r ->> 'fair_max_age_min')::int) then
      v_grade := 'ungraded'; v_reason := 'fair_price_stale';
    else
      v_edge := round((v_fair - public.bet_checker_implied_prob(p_odds)) * 100, 2);
      v_grade := public.bet_checker_grade_of(v_edge);
    end if;
  end if;

  insert into public.user_bets (user_id, bet_key, source, sport, game_id, event_id, market_type, side, team, line, odds, book,
                                units, placed_at, entry_sig_key, entry_fair_price, entry_fair_prob, entry_fair_seen_at,
                                entry_edge_pct, entry_grade, entry_grade_reason, close_status)
  values (p_user, v_key, 'own', v_sport, p_event_id, p_event_id, p_market, p_side,
          case when p_market <> 'total' then v_sel end, v_line, p_odds, v_book, v_units, now(),
          case when v_edge is not null then v_sig end,
          case when v_edge is not null then public.bet_checker_prob_to_american(v_fair) end,
          case when v_edge is not null then v_fair end,
          case when v_edge is not null then v_seen end,
          v_edge, v_grade, v_reason, 'pending')
  returning id into v_id;

  if v_grade in ('green', 'yellow', 'red') then
    insert into public.bet_checker_grades (user_id, bet_id, month_start, paid, grade)
    values (p_user, v_id, v_month, v_paid, v_grade);
  end if;

  select * into b from public.user_bets where id = v_id;
  return jsonb_build_object('ok', true, 'replay', false, 'bet', to_jsonb(b) - 'recommendation',
    'usage', public.bet_checker_usage(p_user), 'upgrade', v_upgrade,
    'rules', jsonb_build_object('green_min_edge_pct', r -> 'green_min_edge_pct', 'red_max_edge_pct', r -> 'red_max_edge_pct'));
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. AFTER THE CLOSE: CLV, THE RESULT, THE FLAG (idempotent)
-- ─────────────────────────────────────────────────────────────────────────────
-- For every open Bet Checker bet whose game has started, and only the parts
-- still to do (each part is terminal once written, so a re-run changes
-- nothing):
--
--   THE FLAG     an EdgeDesk signal on the same event, market and side whose
--                flagged_at (frozen by capture, never rewritten) is at or
--                before the bet was logged. Settled once.
--   THE CLOSE    the board row at the bet's OWN line (event, market,
--                selection, point). Closed with a usable no-vig closing
--                probability -> captured: close_fair_prob, close_odds (that
--                probability as American odds), close_line = the bet's line,
--                and clv_pct = the house CLV (close/index.ts decideClose():
--                entry decimal x closing fair - 1), in percent.
--                Closed without one (line_pulled_no_close: the market closed
--                at another line; no_close_reference; …) -> no_close_available
--                with close's own reason, and close_line set to the line the
--                market DID close at when there was exactly one. Never
--                adjusted to the bet's line.
--                Never priced at that line, while the rest of the game closed
--                -> no_close_available (line_not_on_board_at_close). Nothing
--                closed no_close_after_hours after kickoff -> no_close_available
--                (no_close_captured).
--                close's no_entry_price is about the SIGNAL's own entry price,
--                not the close, so it does not stop a reader's CLV.
--   THE RESULT   settle's word on that same board row (signals.result, read
--                by signal_pnl.sql's pnl_result()), else the final score from
--                the Collective's football settlement for the linked game,
--                graded by the plain rule (spread: margin + line; total:
--                points vs line; moneyline: the winner; equal is a push; a
--                cancelled game is void). No final, no result.
-- Every run is recorded (bet_checker_grade_runs), so "did grading run after
-- the close?" is a query, and grade_user_bets' health probe can say.
create table if not exists public.bet_checker_grade_runs (
  id          bigint generated always as identity primary key,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  source      text        not null default 'sql',
  ok          boolean     not null default true,
  result      jsonb       not null default '{}'::jsonb
);
create index if not exists bet_checker_grade_runs_at_idx on public.bet_checker_grade_runs (started_at desc);
alter table public.bet_checker_grade_runs enable row level security;
revoke all on public.bet_checker_grade_runs from anon, authenticated;

create or replace function public.bet_checker_grade_pending(p_limit int default 500, p_source text default 'sql')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r jsonb := public.bet_checker_rules();
  v_after interval := make_interval(hours => (r ->> 'no_close_after_hours')::int);
  have_pnl boolean := to_regprocedure('public.pnl_result(text)') is not null;
  have_fg2 boolean := to_regclass('collective.fg2_event_links') is not null and to_regclass('collective.fg2_src_games') is not null
                      and to_regprocedure('collective.fg2_game_state(text,numeric,numeric)') is not null;
  b record;
  v_sel text; v_mkt text; v_start timestamptz;
  v_have boolean; v_sig text; v_closed timestamptz; v_fair numeric; v_excl text; v_side_closed boolean;
  v_dec numeric; v_lines numeric[];
  v_word text; v_res text; v_src text; g_status text; g_home numeric; g_away numeric; g_orient text;
  hs numeric; aws numeric; v_state text; x numeric;
  n_seen int := 0; n_flag int := 0; n_cap int := 0; n_noclose int := 0; n_res int := 0;
begin
  if not public.bet_checker_trusted() then
    raise exception 'bet_checker_grade_pending is the service role''s (grade_user_bets)' using errcode = '42501';
  end if;
  for b in
    select u.* from public.user_bets u
     where u.event_id is not null and u.status = 'open'
       and (u.close_status = 'pending' or u.result is null or u.flag_checked_at is null)
       and u.kickoff <= now()
     order by u.kickoff
     limit greatest(1, least(coalesce(p_limit, 500), 5000))
     for update skip locked
  loop
    n_seen := n_seen + 1;
    v_mkt := public.bet_checker_board_market(b.market_type);
    v_sel := case b.side when 'home' then b.home_team when 'away' then b.away_team when 'over' then 'Over' when 'under' then 'Under' end;
    v_dec := public.bet_checker_decimal(b.odds);
    -- when the board says the game starts now (a rescheduled game moves)
    select s2.commence_time into v_start from public.signals s2
     where s2.event_id = b.event_id and s2.market in ('h2h', 'spreads', 'totals') and not coalesce(s2.is_player_prop, false)
     order by s2.last_seen_at desc nulls last limit 1;
    v_start := coalesce(v_start, b.kickoff);
    if v_start > now() then continue; end if;

    -- THE FLAG
    if b.flag_checked_at is null then
      v_sig := null;
      select s2.sig_key into v_sig from public.signals s2
       where s2.event_id = b.event_id and s2.market = v_mkt and s2.selection = v_sel and not coalesce(s2.is_player_prop, false)
         and s2.flagged_at is not null and s2.flagged_at <= b.created_at
       order by s2.flagged_at desc limit 1;
      update public.user_bets set edgedesk_flagged = v_sig is not null, flagged_signal_id = v_sig, flag_checked_at = now()
       where id = b.id;
      if v_sig is not null then n_flag := n_flag + 1; end if;
    end if;

    -- THE CLOSE, at the bet's own line
    if b.close_status = 'pending' then
      v_sig := null; v_closed := null; v_fair := null; v_excl := null;
      select s2.sig_key, s2.closed_at, s2.closing_sharp_fair, s2.clv_excluded_reason into v_sig, v_closed, v_fair, v_excl
        from public.signals s2
       where s2.event_id = b.event_id and s2.market = v_mkt and s2.selection = v_sel
         and s2.point is not distinct from b.line and not coalesce(s2.is_player_prop, false)
       order by s2.closed_at desc nulls last limit 1;
      v_have := v_sig is not null;
      -- the line(s) the market closed at for this side, with a usable close
      select array_agg(distinct s3.point) into v_lines from public.signals s3
       where s3.event_id = b.event_id and s3.market = v_mkt and s3.selection = v_sel and not coalesce(s3.is_player_prop, false)
         and s3.closed_at is not null and s3.closing_sharp_fair > 0 and s3.closing_sharp_fair < 1
         and coalesce(s3.clv_excluded_reason, 'no_entry_price') = 'no_entry_price';
      -- has close run for this side at all?
      select exists (select 1 from public.signals s4 where s4.event_id = b.event_id and s4.market = v_mkt
                        and s4.selection = v_sel and s4.closed_at is not null and not coalesce(s4.is_player_prop, false))
        into v_side_closed;
      if v_have and v_closed is not null then
        if v_fair > 0 and v_fair < 1 and coalesce(v_excl, 'no_entry_price') = 'no_entry_price' then
          update public.user_bets set close_status = 'captured', close_reason = null, close_line = b.line,
                 close_fair_prob = v_fair, close_odds = public.bet_checker_prob_to_american(v_fair),
                 clv_pct = round((v_dec * v_fair - 1) * 100, 2), close_checked_at = now()
           where id = b.id and close_status = 'pending';
          n_cap := n_cap + 1;
        else
          update public.user_bets set close_status = 'no_close_available',
                 close_reason = coalesce(v_excl, 'no_close_price'),
                 close_line = case when b.market_type <> 'moneyline' and cardinality(v_lines) = 1 then v_lines[1] end,
                 close_checked_at = now()
           where id = b.id and close_status = 'pending';
          n_noclose := n_noclose + 1;
        end if;
      elsif not v_have and v_side_closed then
        update public.user_bets set close_status = 'no_close_available', close_reason = 'line_not_on_board_at_close',
               close_line = case when b.market_type <> 'moneyline' and cardinality(v_lines) = 1 then v_lines[1] end,
               close_checked_at = now()
         where id = b.id and close_status = 'pending';
        n_noclose := n_noclose + 1;
      elsif now() > v_start + v_after then
        update public.user_bets set close_status = 'no_close_available', close_reason = 'no_close_captured', close_checked_at = now()
         where id = b.id and close_status = 'pending';
        n_noclose := n_noclose + 1;
      else
        update public.user_bets set close_checked_at = now() where id = b.id;
      end if;
    end if;

    -- THE RESULT
    if b.result is null then
      v_res := null; v_src := null; v_word := null;
      select s2.result into v_word from public.signals s2
       where s2.event_id = b.event_id and s2.market = v_mkt and s2.selection = v_sel
         and s2.point is not distinct from b.line and not coalesce(s2.is_player_prop, false)
         and s2.result is not null
       limit 1;
      if v_word is not null then
        if have_pnl then execute 'select public.pnl_result($1)' into v_res using v_word;
        else v_res := case when lower(btrim(v_word)) in ('win', 'loss', 'push', 'void') then lower(btrim(v_word)) end;
        end if;
        if v_res is not null then v_src := 'settle'; end if;
      end if;
      if v_res is null and have_fg2 then
        begin
          g_status := null; g_home := null; g_away := null; g_orient := null;
          execute 'select g.status::text, g.home_score::numeric, g.away_score::numeric, l.orientation::text
                     from collective.fg2_event_links l join collective.fg2_src_games g on g.game_id = l.canonical_game_id
                    where l.source = ''edgedesk_capture'' and l.source_event_id = $1 and l.status = ''linked'' limit 1'
            into g_status, g_home, g_away, g_orient using b.event_id;
          if g_status is not null or g_home is not null then
            execute 'select collective.fg2_game_state($1, $2, $3)' into v_state using g_status, g_home, g_away;
            -- the board's home team, in the board's orientation
            hs := case when g_orient = 'swapped' then g_away else g_home end;
            aws := case when g_orient = 'swapped' then g_home else g_away end;
            if v_state = 'GAME_CANCELLED' then v_res := 'void'; v_src := 'final_score';
            elsif v_state = 'FINAL' then
              x := case b.market_type
                     when 'spread' then (case b.side when 'home' then hs - aws else aws - hs end) + b.line
                     when 'total' then case b.side when 'over' then (hs + aws) - b.line else b.line - (hs + aws) end
                     when 'moneyline' then case b.side when 'home' then hs - aws else aws - hs end end;
              v_res := case when x > 0 then 'win' when x < 0 then 'loss' else 'push' end;
              v_src := 'final_score';
            end if;
          end if;
        exception when others then v_res := null; v_src := null;   -- a settlement layout this file does not know: no result, never an error
        end;
      end if;
      if v_res is not null then
        update public.user_bets set result = v_res, result_source = v_src, graded_at = now(),
               units_won = case v_res when 'win' then round(b.units * (v_dec - 1), 4) when 'loss' then -b.units else 0 end
         where id = b.id and result is null;
        n_res := n_res + 1;
      end if;
    end if;
  end loop;
  insert into public.bet_checker_grade_runs (started_at, finished_at, source, ok, result)
  values (now(), clock_timestamp(), left(coalesce(p_source, 'sql'), 40), true,
          jsonb_build_object('bets_seen', n_seen, 'flags_found', n_flag, 'closes_captured', n_cap,
                             'no_close', n_noclose, 'results', n_res, 'settle_words', have_pnl, 'final_scores', have_fg2));
  return jsonb_build_object('bets_seen', n_seen, 'flags_found', n_flag, 'closes_captured', n_cap,
                            'no_close', n_noclose, 'results', n_res, 'settle_words', have_pnl, 'final_scores', have_fg2);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. WHAT THE READER SEES
-- ─────────────────────────────────────────────────────────────────────────────
-- Bet Checker's names for the columns it shares with user_bets. RLS applies
-- (security_invoker): a reader sees their own rows only.
create or replace view public.bet_checker_bets with (security_invoker = true) as
select b.id, b.user_id, b.event_id, b.sport, b.market_type as market, b.side, b.team, b.line, b.odds::integer as odds, b.book,
       b.units as stake_units, b.placed_at, b.kickoff, b.home_team, b.away_team,
       b.entry_fair_price, b.entry_fair_prob, b.entry_edge_pct, b.entry_grade, b.entry_grade_reason,
       b.close_odds::integer as closing_price, b.close_line as closing_line, b.close_fair_prob, b.clv_pct,
       b.close_status, b.close_reason, coalesce(b.result, 'pending') as result, b.result_source, b.units_won, b.graded_at,
       b.edgedesk_flagged, b.flagged_signal_id, b.status, b.created_at, b.updated_at
  from public.user_bets b
 where b.event_id is not null;
revoke all on public.bet_checker_bets from anon, authenticated;
grant select on public.bet_checker_bets to authenticated;

-- The caller's bets, newest first. Free: the last free_history_days. Paid
-- (has_bet_checker_paid): the full history.
create or replace function public.my_bet_checker_bets(p_limit int default 200, p_before timestamptz default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_paid boolean;
  v_days int := (public.bet_checker_rules() ->> 'free_history_days')::int;
  v_rows jsonb;
begin
  if v_user is null then raise exception 'bet_checker: sign in first' using errcode = '42501'; end if;
  v_paid := public.has_bet_checker_paid(v_user, now());
  select coalesce(jsonb_agg(to_jsonb(x) order by x.placed_at desc), '[]'::jsonb) into v_rows
    from (select * from public.bet_checker_bets v
           where v.user_id = v_user
             and (p_before is null or v.placed_at < p_before)
             and (v_paid or v.placed_at >= now() - make_interval(days => v_days))
           order by v.placed_at desc
           limit greatest(1, least(coalesce(p_limit, 200), 500))) x;
  return jsonb_build_object('paid', v_paid, 'history_days', case when v_paid then null else v_days end,
    'older_hidden', not v_paid and exists (select 1 from public.user_bets u where u.user_id = v_user and u.event_id is not null
                                             and u.placed_at < now() - make_interval(days => v_days)),
    'usage', public.bet_checker_usage(v_user), 'bets', v_rows);
end;
$$;

-- The running stats and the splits. Paid only: a reader without a paid plan
-- gets {paid:false} and no number at all (the page blurs a placeholder).
-- Voided bets are left out. "Beat the close" is clv_pct > 0.
create or replace function public.my_bet_checker_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_user uuid := auth.uid(); v_out jsonb;
begin
  if v_user is null then raise exception 'bet_checker: sign in first' using errcode = '42501'; end if;
  if not public.has_bet_checker_paid(v_user, now()) then
    return jsonb_build_object('paid', false);
  end if;
  with b as (
    select * from public.user_bets where user_id = v_user and event_id is not null and status = 'open'
  ), agg as (
    select k.dim, k.val,
           count(*)                                                               as bets,
           count(*) filter (where b.entry_grade in ('green', 'yellow', 'red'))     as graded,
           count(*) filter (where b.entry_grade = 'green')                         as green,
           count(*) filter (where b.entry_grade = 'yellow')                        as yellow,
           count(*) filter (where b.entry_grade = 'red')                           as red,
           round(avg(b.entry_edge_pct) filter (where b.entry_grade in ('green', 'yellow', 'red')), 2) as avg_entry_edge_pct,
           count(*) filter (where b.close_status = 'captured')                     as clv_bets,
           count(*) filter (where b.close_status = 'captured' and b.clv_pct > 0)   as beat_close,
           round(100.0 * count(*) filter (where b.close_status = 'captured' and b.clv_pct > 0)
                 / nullif(count(*) filter (where b.close_status = 'captured'), 0), 1) as clv_rate_pct,
           round(avg(b.clv_pct) filter (where b.close_status = 'captured'), 2)    as avg_clv_pct,
           count(*) filter (where b.close_status = 'no_close_available')           as no_close,
           count(*) filter (where b.result = 'win')                                as wins,
           count(*) filter (where b.result = 'loss')                               as losses,
           count(*) filter (where b.result = 'push')                               as pushes,
           round(sum(b.units_won), 2)                                              as units_won
      from b
      cross join lateral (values ('all', 'all'), ('market', b.market_type), ('sport', b.sport), ('book', b.book)) k(dim, val)
     group by k.dim, k.val
  )
  select jsonb_build_object('paid', true,
           'overall', coalesce((select to_jsonb(a) - 'dim' - 'val' from agg a where a.dim = 'all'),
                               jsonb_build_object('bets', 0, 'graded', 0, 'clv_bets', 0)),
           'by_market', coalesce((select jsonb_agg(to_jsonb(a) - 'dim' order by a.bets desc, a.val) from agg a where a.dim = 'market'), '[]'::jsonb),
           'by_sport',  coalesce((select jsonb_agg(to_jsonb(a) - 'dim' order by a.bets desc, a.val) from agg a where a.dim = 'sport'), '[]'::jsonb),
           'by_book',   coalesce((select jsonb_agg(to_jsonb(a) - 'dim' order by a.bets desc, a.val) from agg a where a.dim = 'book'), '[]'::jsonb))
    into v_out;
  return v_out;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. GRANTS
-- ─────────────────────────────────────────────────────────────────────────────
-- A Supabase project grants EXECUTE on every new public function to anon and
-- authenticated by default; revoking from PUBLIC alone leaves those in place.
revoke all on function public.bet_checker_log_bet(uuid, text, text, text, numeric, integer, text, numeric, text) from public, anon, authenticated;
revoke all on function public.bet_checker_grade_pending(integer, text) from public, anon, authenticated;
revoke all on function public.bet_checker_usage(uuid) from public, anon;
revoke all on function public.bet_checker_games(text) from public, anon;
revoke all on function public.bet_checker_lines(text) from public, anon;
revoke all on function public.my_bet_checker_bets(integer, timestamptz) from public, anon;
revoke all on function public.my_bet_checker_stats() from public, anon;
grant execute on function public.bet_checker_usage(uuid), public.bet_checker_games(text), public.bet_checker_lines(text),
  public.my_bet_checker_bets(integer, timestamptz), public.my_bet_checker_stats() to authenticated;
grant execute on function public.bet_checker_rules() to anon, authenticated;
do $g$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.bet_checker_log_bet(uuid, text, text, text, numeric, integer, text, numeric, text), '
         || 'public.bet_checker_grade_pending(integer, text), public.bet_checker_usage(uuid), public.bet_checker_games(text), '
         || 'public.bet_checker_lines(text), public.bet_checker_rules() to service_role';
    execute 'grant select on public.bet_checker_grades, public.bet_checker_bets to service_role';
    execute 'grant select, insert on public.bet_checker_grade_runs to service_role';
  end if;
end
$g$;

notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- THE REPORT. Every row should say ok.
-- ─────────────────────────────────────────────────────────────────────────────
select piece, state from (
  select '01 user_bets carries the entry and the close' as piece,
         case when (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'user_bets'
                     and column_name in ('event_id', 'entry_fair_price', 'entry_edge_pct', 'entry_grade', 'close_status', 'clv_pct',
                                         'edgedesk_flagged', 'flagged_signal_id', 'updated_at')) = 9 then 'ok' else 'CHECK THIS' end as state
  union all select '02 a reader can write none of the grading columns',
         case when not exists (select 1 from information_schema.column_privileges where table_schema = 'public' and table_name = 'user_bets'
                                  and grantee in ('anon', 'authenticated') and privilege_type = 'UPDATE'
                                  and column_name in ('entry_fair_price', 'entry_fair_prob', 'entry_edge_pct', 'entry_grade', 'close_status',
                                                      'close_line', 'close_odds', 'clv_pct', 'result', 'graded_at', 'edgedesk_flagged'))
               and exists (select 1 from pg_trigger where tgname = 'user_bets_bet_checker_insert_trg' and not tgisinternal)
              then 'ok' else 'CHECK THIS' end
  union all select '03 user_bets RLS is on (own rows only)',
         case when (select relrowsecurity from pg_class where oid = 'public.user_bets'::regclass) then 'ok' else 'CHECK THIS' end
  union all select '04 the owner is a real account (user_bets_user_fk)',
         case when exists (select 1 from pg_constraint where conname = 'user_bets_user_fk' and convalidated) then 'ok'
              when exists (select 1 from pg_constraint where conname = 'user_bets_user_fk') then 'ok (new rows checked; NOT VALID over old rows that name no account)'
              else 'CHECK THIS' end
  union all select '05 the flagged signal is a board row',
         case when exists (select 1 from pg_constraint where conname = 'user_bets_flagged_signal_fk') then 'ok'
              else 'ok (no unique sig_key index on signals: flagged_signal_id is checked by the grader, not a foreign key)' end
  union all select '06 indexes: (user_id, placed_at desc) and (event_id, market)',
         case when to_regclass('public.user_bets_user_idx') is not null and to_regclass('public.user_bets_event_market_idx') is not null
              then 'ok' else 'CHECK THIS' end
  union all select '07 the free allowance ledger is private and append-only to readers',
         case when (select relrowsecurity from pg_class where oid = 'public.bet_checker_grades'::regclass)
               and not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and table_name = 'bet_checker_grades'
                                 and grantee in ('anon', 'authenticated') and privilege_type in ('INSERT', 'UPDATE', 'DELETE'))
              then 'ok' else 'CHECK THIS' end
  union all select '08 only the service role logs a graded bet or runs the grader',
         case when not has_function_privilege('authenticated', 'public.bet_checker_log_bet(uuid,text,text,text,numeric,integer,text,numeric,text)', 'execute')
               and not has_function_privilege('anon', 'public.bet_checker_log_bet(uuid,text,text,text,numeric,integer,text,numeric,text)', 'execute')
               and not has_function_privilege('authenticated', 'public.bet_checker_grade_pending(integer,text)', 'execute')
              then 'ok' else 'CHECK THIS' end
  union all select '09 the grade follows the one constant, bet_checker_rules()',
         case when public.bet_checker_grade_of((public.bet_checker_rules() ->> 'green_min_edge_pct')::numeric) = 'green'
               and public.bet_checker_grade_of((public.bet_checker_rules() ->> 'green_min_edge_pct')::numeric - 0.01) = 'yellow'
               and public.bet_checker_grade_of((public.bet_checker_rules() ->> 'red_max_edge_pct')::numeric + 0.01) = 'yellow'
               and public.bet_checker_grade_of((public.bet_checker_rules() ->> 'red_max_edge_pct')::numeric) = 'red'
              then 'ok (green >= ' || (public.bet_checker_rules() ->> 'green_min_edge_pct') || ', red <= '
                   || (public.bet_checker_rules() ->> 'red_max_edge_pct') || ')'
              else 'CHECK THIS' end
  union all select '10 upcoming NFL / college football games on the board',
         'ok (' || (select count(*) from public.bet_checker_games(null))::text || ')'
  union all select '11 Bet Checker bets on file',
         'ok (' || (select count(*) from public.user_bets where event_id is not null)::text || ')'
) r order by 1;
