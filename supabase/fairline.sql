-- =============================================================================
-- fairline.sql — Fairline: The Board (is this a good number right now?) and
-- The Leaks (where am I losing money, and is it bad bets or bad luck?).
-- docs/fairline.md
--
-- NO PICKS. Fairline never says what to bet. The Board measures the prices
-- capture recorded against EdgeDesk's de-vigged fair price. The Leaks measure
-- the reader's OWN bets against their results and against EdgeDesk's captured
-- close. Where the pipeline does not own a number it is not shown, and a
-- small sample is labelled a small sample.
--
-- WHAT IT BUILDS ON (nothing here is a second copy of something that exists):
--   public.signals          capture's board. sharp_fair is THE fair probability
--                           EdgeDesk anchors on for one exact line; best_dec /
--                           best_book the best price capture saw, and
--                           best_quote_age_s how old it was then. Close writes
--                           closing_sharp_fair / clv_excluded_reason /
--                           closed_at on the same row. RLS on signals is the
--                           terminal's (has_active_sub()) and is NOT loosened:
--                           The Board reads it through one security-definer
--                           door, fairline_board(), that checks the paid gate
--                           and returns only the columns the page needs.
--   public.book_quotes      (optional) per-book quotes, written by capture v9
--                           for ACTIONABLE signals only. Preferred where a
--                           row has them; signals.best_dec otherwise.
--   public.kalshi_card_current (optional) the Kalshi price for a linked game
--                           winner, with the card's own display rule: a price
--                           only when its state is OK.
--   public.user_bets        Bet Checker's logs (bet_checker.sql): units,
--                           result, units_won, and the house CLV (clv_pct)
--                           at the bet's own line.
--   public.portfolio_positions  the Portfolio: Juice Reel syncs, CSV,
--                           screenshot and paste imports, manual entries. Its
--                           money (cost_basis, profit_loss) is derived by its
--                           own trigger; its matched market is market_sig_key
--                           (bet_import.sql), which is how its CLV is read
--                           from signals, by the same house formula.
--   public.bankroll_settings  the reader's unit (bettor_decisions.sql), used
--                           only to show a unit as dollars or dollars as units.
--   has_bet_checker_paid()  billing_hardening.sql. THE GATE, for now: every
--                           Fairline gate calls fairline_paid(), and
--                           fairline_paid() calls this. The Fairline tier is
--                           a separate billing change.
--
-- THE RULES live in ONE constant, fairline_rules().
--
-- WHO SEES WHAT
--   fairline_my_bets() / view fairline_bets   the caller's own bets, both
--                    sources, one row per bet (a bet in both is one row).
--                    Paid only; owner only by construction (auth.uid()).
--   fairline_leaks() the slices and their labels. Paid: everything. Free:
--                    the name of the biggest leak's slice, and no number.
--   fairline_board() The Board. Paid: every row, with filters. Free: the
--                    top three fresh rows, and how many more there are.
--   fairline_bets_for(uuid) / fairline_slices_for(uuid)  the same, for one
--                    named account: the caller themselves or the service role.
--
-- REQUIRES bettor_decisions.sql (user_bets, bankroll_settings),
-- billing_hardening.sql (has_bet_checker_paid), bet_checker.sql (the Bet
-- Checker columns and bet_checker_trusted), portfolio.sql and bet_import.sql
-- (portfolio_positions.market_sig_key / price_american), and capture's
-- public.signals.
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- Mirrored byte for byte in migrations/20261028180000_fairline.sql.
-- =============================================================================

do $req$
declare missing text;
begin
  if to_regclass('public.user_bets') is null or to_regclass('public.bankroll_settings') is null then
    raise exception 'fairline.sql reads public.user_bets and public.bankroll_settings: apply supabase/bettor_decisions.sql first';
  end if;
  if to_regprocedure('public.has_bet_checker_paid(uuid,timestamptz)') is null then
    raise exception 'fairline.sql needs public.has_bet_checker_paid(): apply supabase/billing_hardening.sql first';
  end if;
  if to_regprocedure('public.bet_checker_trusted()') is null or to_regprocedure('public.bet_checker_decimal(numeric)') is null then
    raise exception 'fairline.sql reads Bet Checker''s grades: apply supabase/bet_checker.sql first';
  end if;
  if to_regclass('public.portfolio_positions') is null then
    raise exception 'fairline.sql reads public.portfolio_positions: apply supabase/portfolio.sql first';
  end if;
  if to_regprocedure('public.portfolio_decimal_to_american(numeric)') is null then
    raise exception 'fairline.sql reads portfolio_positions.market_sig_key: apply supabase/bet_import.sql first';
  end if;
  if to_regclass('public.signals') is null then
    raise exception 'fairline.sql reads public.signals (capture''s board), which does not exist here';
  end if;
  select string_agg(c, ', ') into missing
    from unnest(array['sig_key', 'event_id', 'sport_key', 'sport_title', 'commence_time', 'home_team', 'away_team', 'market',
                      'selection', 'point', 'sharp_fair', 'last_seen_at', 'point_is_modal', 'best_dec', 'best_book',
                      'best_quote_age_s', 'closed_at', 'closing_sharp_fair', 'clv_excluded_reason']) c
   where not exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'signals' and column_name = c);
  if missing is not null then
    raise exception 'fairline.sql: public.signals has no column(s) % (capture / close write them)', missing;
  end if;
  select string_agg(c, ', ') into missing
    from unnest(array['market_sig_key', 'price_american']) c
   where not exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'portfolio_positions' and column_name = c);
  if missing is not null then
    raise exception 'fairline.sql: public.portfolio_positions has no column(s) %: apply supabase/bet_import.sql first', missing;
  end if;
  select string_agg(c, ', ') into missing
    from unnest(array['event_id', 'clv_pct', 'close_status', 'entry_sig_key']) c
   where not exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'user_bets' and column_name = c);
  if missing is not null then
    raise exception 'fairline.sql: public.user_bets has no column(s) %: apply supabase/bet_checker.sql first', missing;
  end if;
end
$req$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. THE RULES — one constant
-- ─────────────────────────────────────────────────────────────────────────────
-- THE LEAKS
--   min_sample_bets  a slice needs this many SETTLED bets before it gets any
--                    label. Below it the slice says "small sample".
--   min_clv_bets     and this many bets with a captured close before its label
--                    can say anything about the close. Below it the slice is
--                    labelled on P/L alone, and says so.
--   odds_buckets     American odds, both ends inclusive (rounded to a whole
--                    number first; -100 and +100 are the same price).
--   lead_buckets     hours from the bet to the start: from inclusive, to
--                    exclusive. A bet placed at or after the start is live; a
--                    bet with no known start is unknown.
--   stake_buckets    the stake over the reader's median stake: from inclusive,
--                    to exclusive.
--   no_close_after_hours  a close not captured this long after the start
--                    never will be (bet_checker_rules() says the same).
-- THE BOARD
--   board_days_ahead games that start within this many days.
--   freshness        how old a price may be and still be a price: capture's
--                    own FRESHNESS_POLICY (supabase/functions/capture/index.ts),
--                    in minutes, by sport group and hours to the start. A row
--                    past it is greyed out and sorted after every fresh row.
--   free_board_rows  what a free account sees of The Board.
create or replace function public.fairline_rules()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'version',               'fairline-v1',
    'min_sample_bets',       15,
    'min_clv_bets',          15,
    'top_leaks',             3,
    'no_close_after_hours',  24,
    'odds_buckets', jsonb_build_array(
      jsonb_build_object('key', 'le_m200',   'from', null, 'to', -200),
      jsonb_build_object('key', 'm199_m121', 'from', -199, 'to', -121),
      jsonb_build_object('key', 'm120_p120', 'from', -120, 'to', 120),
      jsonb_build_object('key', 'p121_p200', 'from', 121,  'to', 200),
      jsonb_build_object('key', 'gt_p200',   'from', 201,  'to', null)),
    'lead_buckets', jsonb_build_array(
      jsonb_build_object('key', '48h_plus', 'from', 48, 'to', null),
      jsonb_build_object('key', '24_48h',   'from', 24, 'to', 48),
      jsonb_build_object('key', '6_24h',    'from', 6,  'to', 24),
      jsonb_build_object('key', 'under_6h', 'from', 0,  'to', 6)),
    'stake_buckets', jsonb_build_array(
      jsonb_build_object('key', 'small',     'from', null, 'to', 0.75),
      jsonb_build_object('key', 'typical',   'from', 0.75, 'to', 1.25),
      jsonb_build_object('key', 'large',     'from', 1.25, 'to', 2),
      jsonb_build_object('key', 'oversized', 'from', 2,    'to', null)),
    'sport_aliases', jsonb_build_object('NCAAF', 'CFB', 'COLLEGE FOOTBALL', 'CFB', 'NCAA FOOTBALL', 'CFB',
                                        'NCAAB', 'CBB', 'COLLEGE BASKETBALL', 'CBB', 'NCAA BASKETBALL', 'CBB'),
    'board_days_ahead',      7,
    'board_max_rows',        1500,
    'free_board_rows',       3,
    'freshness_hours', jsonb_build_array(
      jsonb_build_object('name', 'imminent', 'to_hours', 0.5),
      jsonb_build_object('name', 'close',    'to_hours', 2),
      jsonb_build_object('name', 'soon',     'to_hours', 6),
      jsonb_build_object('name', 'day',      'to_hours', 24),
      jsonb_build_object('name', 'far',      'to_hours', 72),
      jsonb_build_object('name', 'deep',     'to_hours', null)),
    'freshness_min', jsonb_build_object(
      'nfl',   jsonb_build_object('imminent', 4, 'close', 10, 'soon', 30, 'day', 60, 'far', 120, 'deep', 240),
      'ncaaf', jsonb_build_object('imminent', 5, 'close', 15, 'soon', 45, 'day', 90, 'far', 180, 'deep', 360),
      '*',     jsonb_build_object('imminent', 5, 'close', 15, 'soon', 40, 'day', 80, 'far', 160, 'deep', 320)));
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. THE GATE — one helper
-- ─────────────────────────────────────────────────────────────────────────────
-- Every Fairline gate calls this, and nothing else. For now it is Bet
-- Checker's paid plan (red) or the Research Terminal (blue).
create or replace function public.fairline_paid(p_user uuid, p_at timestamptz default now())
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_user is not null and coalesce(public.has_bet_checker_paid(p_user, p_at), false);
$$;
comment on function public.fairline_paid(uuid, timestamptz) is
  'THE Fairline gate. Every Fairline door calls this. Today: has_bet_checker_paid() (red or blue in good standing).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. THE BUCKETS
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.fairline_odds_bucket(p_american numeric)
returns text language sql immutable as $$
  select case when p_american is null or abs(p_american) < 100 then null else (
    select e ->> 'key' from jsonb_array_elements(public.fairline_rules() -> 'odds_buckets') e
     where (jsonb_typeof(e -> 'from') <> 'number' or round(p_american) >= (e ->> 'from')::numeric)
       and (jsonb_typeof(e -> 'to') <> 'number' or round(p_american) <= (e ->> 'to')::numeric)
     limit 1) end;
$$;

-- a range list: from inclusive, to exclusive
create or replace function public.fairline_range_bucket(p_list jsonb, p_x numeric)
returns text language sql immutable as $$
  select (select e ->> 'key' from jsonb_array_elements(p_list) e
           where (jsonb_typeof(e -> 'from') <> 'number' or p_x >= (e ->> 'from')::numeric)
             and (jsonb_typeof(e -> 'to') <> 'number' or p_x < (e ->> 'to')::numeric)
           limit 1)
   where p_x is not null;
$$;

create or replace function public.fairline_lead_bucket(p_placed timestamptz, p_start timestamptz)
returns text language sql immutable as $$
  select case when p_start is null or p_placed is null then 'unknown'
              when p_placed >= p_start then 'live'
              else public.fairline_range_bucket(public.fairline_rules() -> 'lead_buckets',
                                                extract(epoch from (p_start - p_placed)) / 3600.0) end;
$$;

create or replace function public.fairline_stake_bucket(p_ratio numeric)
returns text language sql immutable as $$
  select coalesce(public.fairline_range_bucket(public.fairline_rules() -> 'stake_buckets', p_ratio), 'unknown');
$$;

-- a sport as one name, whichever source wrote it ('NFL', 'Football' + 'NFL', 'NCAAF')
create or replace function public.fairline_sport(p_sport text, p_league text)
returns text language sql immutable as $$
  select coalesce(public.fairline_rules() -> 'sport_aliases' ->> x, x, 'Other')
    from (select upper(btrim(coalesce(nullif(btrim(p_league), ''), nullif(btrim(p_sport), '')))) as x) s;
$$;

-- THE LABEL. P/L is the sign of the slice's return; "beating the close" is an
-- average house CLV above zero.
--   real_leak    losing, and not beating the close
--   bad_luck     losing, but beating the close
--   running_hot  not losing, but not beating the close
--   real_edge    not losing, and beating the close
--   losing / winning   enough bets, not enough captured closes: P/L only
--   null         a small sample (no label at all)
create or replace function public.fairline_label(p_bets integer, p_clv_bets integer, p_return numeric, p_avg_clv numeric)
returns text language sql immutable as $$
  select case
    when coalesce(p_bets, 0) < (public.fairline_rules() ->> 'min_sample_bets')::int or p_return is null then null
    when coalesce(p_clv_bets, 0) < (public.fairline_rules() ->> 'min_clv_bets')::int or p_avg_clv is null then
      case when p_return < 0 then 'losing' else 'winning' end
    when p_return < 0 and p_avg_clv <= 0 then 'real_leak'
    when p_return < 0 then 'bad_luck'
    when p_avg_clv <= 0 then 'running_hot'
    else 'real_edge' end;
$$;

-- the board's freshness limit for one row, in minutes
create or replace function public.fairline_fresh_limit_min(p_sport_key text, p_hours_to_start numeric)
returns integer language sql immutable as $$
  with r as (select public.fairline_rules() as j),
       g as (select case when lower(coalesce(p_sport_key, '')) like 'americanfootball\_nfl%' then 'nfl'
                         when lower(coalesce(p_sport_key, '')) like 'americanfootball\_ncaaf%' then 'ncaaf'
                         else '*' end as grp),
       b as (select (select e ->> 'name' from jsonb_array_elements(r.j -> 'freshness_hours') with ordinality t(e, n)
                      where jsonb_typeof(e -> 'to_hours') <> 'number' or greatest(p_hours_to_start, 0) <= (e ->> 'to_hours')::numeric
                      order by n limit 1) as name
               from r)
  select (r.j -> 'freshness_min' -> g.grp ->> b.name)::int from r, g, b;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. ONE VIEW OF THE READER'S BETS, FROM BOTH SOURCES
-- ─────────────────────────────────────────────────────────────────────────────
-- One row per bet. A bet the reader logged in Bet Checker AND has in the
-- Portfolio is ONE row (source 'both'). Two rows are the same bet when, in
-- this order of certainty:
--   linked       the position names the Bet Checker row (edge_ref_type
--                'user_bet', edge_ref_id = its id);
--   same_market  the position's matched capture key is the bet's exact market
--                (event, market, selection, line) at the same American odds,
--                placed within 36 hours of each other;
--   same_game    a straight sportsbook position on the same start (within 10
--                minutes), market type, line and American odds, whose
--                selection names the same side, placed within 36 hours.
-- Each row pairs at most once, the most certain and closest pair first, so
-- two identical bets in each source are two bets, never one and never four.
-- Nothing else is merged: a wrong merge would hide a real bet.
--
-- A merged bet keeps the book's record of the money (the position: stake,
-- result, P/L in dollars) and Bet Checker's units and its captured close.
--
-- THE MONEY. A Bet Checker bet is in units; its dollars are the units times
-- the bet's own recorded unit value (stake_dollars / unit_value), else the
-- reader's unit in bankroll_settings (dollars_basis 'unit_size'), else none.
-- A position is in dollars (cost_basis + fees, profit_loss); its units are
-- dollars over the reader's unit, else none. Nothing is guessed.
--
-- THE CLOSE (house CLV, close/index.ts decideClose: entry decimal x the
-- no-vig closing probability - 1, at the SAME line). A Bet Checker bet: its
-- own clv_pct. A position: only a straight sportsbook spread, total or
-- moneyline, matched to a capture key at its own line, placed before the
-- start; read from that signal's close. Anything else has no CLV
-- (not_applicable), and a live bet is never graded against a pregame close.
create or replace function public.fairline_bets_for(p_user uuid)
returns table (bet_ref text, source text, bet_id uuid, position_id uuid, platform text, sport text, market text, bet_type text,
               event text, selection text, line numeric, odds_american integer, placed_at timestamptz, starts_at timestamptz,
               stake_units numeric, stake_dollars numeric, dollars_basis text, result text, settled boolean,
               pl_units numeric, pl_dollars numeric, clv_pct numeric, clv_status text, matched_by text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_unit numeric;
  v_after interval := make_interval(hours => (public.fairline_rules() ->> 'no_close_after_hours')::int);
  c record;
  used_b uuid[] := '{}'; used_p uuid[] := '{}';
  pair_b uuid[] := '{}'; pair_p uuid[] := '{}'; pair_how text[] := '{}';
begin
  if p_user is null then return; end if;
  if auth.uid() is distinct from p_user and not public.bet_checker_trusted() then
    raise exception 'fairline: a reader may only read their own bets' using errcode = '42501';
  end if;
  select case when bs.unit_mode = 'fixed' then bs.base_unit_amount
              when bs.unit_mode = 'percent' and bs.bankroll_amount is not null then round(bs.bankroll_amount * bs.unit_percent, 2) end
    into v_unit
    from public.bankroll_settings bs where bs.user_id = p_user;

  -- the pairs, most certain and closest first
  for c in
    with ub as (
      select u.id, u.event_id, u.market_type, u.side, u.line, u.odds, u.placed_at, u.kickoff,
             public.bet_checker_board_market(u.market_type) as bmkt,
             case u.side when 'home' then coalesce(u.team, u.home_team) when 'away' then coalesce(u.team, u.away_team)
                         when 'over' then 'Over' when 'under' then 'Under' end as sel
        from public.user_bets u
       where u.user_id = p_user and u.status = 'open' and coalesce(u.result, '') <> 'void'
    ), pp as (
      select p.id, p.edge_ref_type, p.edge_ref_id, p.market_sig_key, p.position_type, p.platform_type, p.line, p.placed_at,
             p.event_start_at, lower(coalesce(p.side, '') || ' ' || coalesce(p.selection, '')) as words,
             coalesce(p.price_american, p.odds_american, public.portfolio_decimal_to_american(p.odds_decimal)) as am,
             (p.position_type in ('PARLAY', 'SAME_GAME_PARLAY') or jsonb_array_length(coalesce(p.legs, '[]'::jsonb)) > 1) as is_parlay
        from public.portfolio_positions p
       where p.user_id = p_user and p.status <> 'VOID'
    ), cand as (
      select ub.id as b, pp.id as p, 1 as rk, 'linked'::text as how, abs(extract(epoch from (pp.placed_at - ub.placed_at))) as dt
        from ub join pp on pp.edge_ref_type = 'user_bet' and pp.edge_ref_id = ub.id::text
      union all
      select ub.id, pp.id, 2, 'same_market', abs(extract(epoch from (pp.placed_at - ub.placed_at)))
        from ub join pp on not pp.is_parlay and pp.market_sig_key is not null
         and split_part(pp.market_sig_key, '|', 1) = ub.event_id
         and split_part(pp.market_sig_key, '|', 2) = ub.bmkt
         and split_part(pp.market_sig_key, '|', 3) = ub.sel
         and public.portfolio_try_numeric(nullif(split_part(pp.market_sig_key, '|', 4), '')) is not distinct from ub.line
         and pp.am = ub.odds
         and abs(extract(epoch from (pp.placed_at - ub.placed_at))) <= 36 * 3600
      union all
      select ub.id, pp.id, 3, 'same_game', abs(extract(epoch from (pp.placed_at - ub.placed_at)))
        from ub join pp on not pp.is_parlay and pp.platform_type = 'SPORTSBOOK'
         and ub.kickoff is not null and pp.event_start_at is not null
         and abs(extract(epoch from (pp.event_start_at - ub.kickoff))) <= 600
         and pp.position_type = upper(ub.market_type)
         and pp.line is not distinct from ub.line
         and pp.am = ub.odds
         and abs(extract(epoch from (pp.placed_at - ub.placed_at))) <= 36 * 3600
         and case when ub.market_type = 'total' then pp.words ~ ('(^|\s)' || ub.side || '(\s|$)')
                  else ub.sel is not null and position(lower(regexp_replace(btrim(ub.sel), '^.*\s', '')) in pp.words) > 0 end
    )
    select cand.b, cand.p, cand.how from cand order by cand.rk, cand.dt, cand.b, cand.p
  loop
    if c.b = any (used_b) or c.p = any (used_p) then continue; end if;
    used_b := used_b || c.b; used_p := used_p || c.p;
    pair_b := pair_b || c.b; pair_p := pair_p || c.p; pair_how := pair_how || c.how;
  end loop;

  return query
    with ub as (
      select u.id, u.sport as sport_raw, u.market_type, u.side, u.line, u.odds, u.placed_at, u.kickoff, u.units,
             coalesce(nullif(btrim(u.book), ''), 'Unknown') as platform,
             coalesce(u.away_team, 'Away') || ' at ' || coalesce(u.home_team, 'Home') as event,
             case u.market_type
               when 'total' then initcap(u.side) || ' ' || coalesce(trim_scale(u.line)::text, '')
               when 'moneyline' then coalesce(u.team, case u.side when 'home' then u.home_team else u.away_team end, initcap(u.side)) || ' ML'
               else coalesce(u.team, case u.side when 'home' then u.home_team else u.away_team end, initcap(u.side))
                    || ' ' || case when u.line > 0 then '+' else '' end || coalesce(trim_scale(u.line)::text, '') end as selection,
             coalesce(u.result in ('win', 'loss', 'push'), false) as settled,
             coalesce(u.result, 'pending') as result,
             u.units_won,
             coalesce(u.stake_dollars / nullif(u.units, 0), u.unit_value) as own_unit,
             case when u.close_status = 'captured' then u.clv_pct end as clv_pct,
             case u.close_status when 'captured' then 'captured' when 'no_close_available' then 'no_close'
                                 when 'pending' then 'pending' else 'not_applicable' end as clv_status
        from public.user_bets u
       where u.user_id = p_user and u.status = 'open' and coalesce(u.result, '') <> 'void'
    ), ubn as (
      select ub.*,
             coalesce(ub.own_unit, v_unit) as unit_dollars,
             case when ub.own_unit is not null then 'recorded' when v_unit is not null then 'unit_size' end as dollars_basis
        from ub
    ), pp as (
      select p.id, p.platform_label, p.platform_type, p.position_type, p.sport, p.league, p.event_name, p.selection, p.side, p.line,
             p.placed_at, p.status, p.result, p.profit_loss, p.cost_basis, p.fees, p.market_sig_key,
             coalesce(p.price_american, p.odds_american, public.portfolio_decimal_to_american(p.odds_decimal)) as am,
             coalesce(p.odds_decimal, public.bet_checker_decimal(p.odds_american)) as dec,
             (p.position_type in ('PARLAY', 'SAME_GAME_PARLAY') or jsonb_array_length(coalesce(p.legs, '[]'::jsonb)) > 1) as is_parlay,
             coalesce(p.event_start_at, s.commence_time) as starts_at,
             s.sig_key as s_key, s.point as s_point, s.closed_at as s_closed, s.closing_sharp_fair as s_fair, s.clv_excluded_reason as s_excl
        from public.portfolio_positions p
        left join public.signals s on s.sig_key = p.market_sig_key
       where p.user_id = p_user and p.status <> 'VOID'
    ), ppn as (
      select pp.*,
             pp.status <> 'OPEN' as settled,
             case when pp.status = 'OPEN' then 'pending'
                  when upper(coalesce(pp.result, '')) = 'WIN' then 'win'
                  when upper(coalesce(pp.result, '')) = 'LOSS' then 'loss'
                  when upper(coalesce(pp.result, '')) = 'PUSH' then 'push'
                  when upper(coalesce(pp.result, '')) = 'CASHOUT' then 'cashout'
                  when pp.profit_loss > 0 then 'win' when pp.profit_loss < 0 then 'loss' else 'push' end as res,
             coalesce(pp.cost_basis, 0) + coalesce(pp.fees, 0) as stake_d,
             case when pp.is_parlay then 'parlay'
                  else case pp.position_type when 'MONEYLINE' then 'moneyline' when 'SPREAD' then 'spread' when 'TOTAL' then 'total'
                                             when 'PLAYER_PROP' then 'props' else 'other' end end as mkt,
             -- the house CLV, only where the pipeline owns the close
             (pp.platform_type = 'SPORTSBOOK' and not pp.is_parlay and pp.position_type in ('MONEYLINE', 'SPREAD', 'TOTAL')
              and pp.market_sig_key is not null and pp.dec > 1
              and pp.line is not distinct from public.portfolio_try_numeric(nullif(split_part(pp.market_sig_key, '|', 4), ''))
              and (pp.starts_at is null or pp.placed_at < pp.starts_at)) as clv_ok
        from pp
    ), ppc as (
      select ppn.*,
             case when not ppn.clv_ok then 'not_applicable'
                  when ppn.s_key is not null and ppn.s_closed is not null and ppn.s_fair > 0 and ppn.s_fair < 1
                       and coalesce(ppn.s_excl, 'no_entry_price') = 'no_entry_price' then 'captured'
                  when ppn.s_closed is not null or ppn.s_key is null then 'no_close'
                  when ppn.starts_at is not null and now() > ppn.starts_at + v_after then 'no_close'
                  else 'pending' end as cst
        from ppn
    ), ppx as (
      select ppc.*,
             case when ppc.cst = 'captured' then round((ppc.dec * ppc.s_fair - 1) * 100, 2) end as clv
        from ppc
    ), pairs as (
      select x.b, x.p, x.how from unnest(pair_b, pair_p, pair_how) as x(b, p, how)
    )
    -- Bet Checker only
    select 'ub:' || u.id::text, 'bet_checker'::text, u.id, null::uuid, u.platform, public.fairline_sport(u.sport_raw, null), u.market_type,
           'straight'::text, u.event, u.selection, u.line, u.odds::integer, u.placed_at, u.kickoff,
           u.units, round(u.units * u.unit_dollars, 2), u.dollars_basis, u.result, u.settled,
           case when u.settled then u.units_won end,
           case when u.settled then round(u.units_won * u.unit_dollars, 2) end,
           u.clv_pct, u.clv_status, null::text
      from ubn u
     where not (u.id = any (pair_b))
    union all
    -- Portfolio only
    select 'pp:' || p.id::text, 'portfolio'::text, null::uuid, p.id, p.platform_label, public.fairline_sport(p.sport, p.league), p.mkt,
           case when p.is_parlay then 'parlay' else 'straight' end, p.event_name,
           p.selection || case when p.side is not null and position(lower(p.side) in lower(p.selection)) = 0 then ' (' || p.side || ')' else '' end,
           p.line, p.am, p.placed_at, p.starts_at,
           case when v_unit > 0 then round(p.stake_d / v_unit, 4) end, p.stake_d, 'recorded'::text, p.res, p.settled,
           case when p.settled and v_unit > 0 then round(p.profit_loss / v_unit, 4) end,
           case when p.settled then p.profit_loss end,
           p.clv, p.cst, null::text
      from ppx p
     where not (p.id = any (pair_p))
    union all
    -- in both: one bet. The book's money, Bet Checker's units and close.
    select 'both:' || u.id::text || ':' || p.id::text, 'both'::text, u.id, p.id, p.platform_label, public.fairline_sport(u.sport_raw, null),
           u.market_type, 'straight'::text, u.event, u.selection, u.line, coalesce(p.am, u.odds::integer),
           least(u.placed_at, p.placed_at), coalesce(u.kickoff, p.starts_at),
           u.units, p.stake_d, 'recorded'::text,
           case when p.settled then p.res else u.result end,
           p.settled or u.settled,
           case when p.settled and p.stake_d > 0 then round(u.units * p.profit_loss / p.stake_d, 4)
                when u.settled then u.units_won end,
           case when p.settled then p.profit_loss
                when u.settled then round(u.units_won * coalesce(p.stake_d / nullif(u.units, 0), u.unit_dollars), 2) end,
           coalesce(u.clv_pct, p.clv),
           case when u.clv_status = 'captured' or p.cst <> 'captured' then u.clv_status else p.cst end,
           x.how
      from pairs x
      join ubn u on u.id = x.b
      join ppx p on p.id = x.p;
end;
$$;

-- The caller's own bets. Paid only: a free account gets no rows.
create or replace function public.fairline_my_bets()
returns table (bet_ref text, source text, bet_id uuid, position_id uuid, platform text, sport text, market text, bet_type text,
               event text, selection text, line numeric, odds_american integer, placed_at timestamptz, starts_at timestamptz,
               stake_units numeric, stake_dollars numeric, dollars_basis text, result text, settled boolean,
               pl_units numeric, pl_dollars numeric, clv_pct numeric, clv_status text, matched_by text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'fairline: sign in first' using errcode = '42501'; end if;
  if not public.fairline_paid(auth.uid(), now()) then return; end if;
  return query select * from public.fairline_bets_for(auth.uid());
end;
$$;

-- The view of the same thing, for PostgREST and the SQL editor. Owner only by
-- construction: the function reads auth.uid(), and nothing else.
create or replace view public.fairline_bets as select * from public.fairline_my_bets();
comment on view public.fairline_bets is
  'The caller''s own bets from Bet Checker and the Portfolio, one row per bet (a bet in both is one row). Paid only; owner only.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. THE LEAKS
-- ─────────────────────────────────────────────────────────────────────────────
-- Every slice of one account's bets, by: sport, market, bet type, odds range,
-- lead time, book, and stake over their median stake (plus 'all').
--
-- Per slice: bets (settled), pending, the record, units and dollars P/L and
-- staked, ROI, average CLV, the beat-close rate, and the label.
--
-- THE RETURN a label is read from, in the slice's own measure:
--   dollars  when every settled bet in it has dollars;
--   units    else, when every settled bet has units;
--   flat     else, each bet's own return on its own stake, one unit each.
-- A return of exactly zero counts as not losing.
--
-- Void bets are left out. A cash-out is settled, with the money it paid.
create or replace function public.fairline_slices_for(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  r jsonb := public.fairline_rules();
  v_out jsonb;
begin
  if p_user is null then return '[]'::jsonb; end if;
  if auth.uid() is distinct from p_user and not public.bet_checker_trusted() then
    raise exception 'fairline: a reader may only read their own leaks' using errcode = '42501';
  end if;
  with b as (
    select * from public.fairline_bets_for(p_user)
  ), med as (
    select percentile_cont(0.5) within group (order by b.stake_dollars) filter (where b.stake_dollars > 0) as md,
           percentile_cont(0.5) within group (order by b.stake_units) filter (where b.stake_units > 0) as mu
      from b
  ), bx as (
    select b.*,
           coalesce(public.fairline_odds_bucket(b.odds_american), 'unknown') as odds_b,
           public.fairline_lead_bucket(b.placed_at, b.starts_at) as lead_b,
           public.fairline_stake_bucket(case when b.stake_dollars > 0 and med.md > 0 then b.stake_dollars / med.md::numeric
                                             when b.stake_units > 0 and med.mu > 0 then b.stake_units / med.mu::numeric end) as stake_b,
           case when b.stake_dollars > 0 and b.pl_dollars is not null then b.pl_dollars / b.stake_dollars
                when b.stake_units > 0 and b.pl_units is not null then b.pl_units / b.stake_units end as ret
      from b cross join med
  ), d as (
    select bx.*, k.dim, k.val
      from bx cross join lateral (values ('all', 'all'), ('sport', bx.sport), ('market', bx.market), ('bet_type', bx.bet_type),
                                         ('odds', bx.odds_b), ('lead', bx.lead_b), ('book', bx.platform), ('stake', bx.stake_b)) k(dim, val)
  ), agg as (
    select d.dim, d.val,
           count(*) filter (where d.settled)::int                                              as bets,
           count(*) filter (where not d.settled)::int                                          as pending,
           count(*) filter (where d.result = 'win')::int                                       as wins,
           count(*) filter (where d.result = 'loss')::int                                      as losses,
           count(*) filter (where d.result = 'push')::int                                      as pushes,
           count(*) filter (where d.result = 'cashout')::int                                   as cashouts,
           count(*) filter (where d.settled and d.pl_dollars is not null and d.stake_dollars is not null)::int as dollars_bets,
           count(*) filter (where d.settled and d.pl_units is not null and d.stake_units is not null)::int     as units_bets,
           count(*) filter (where d.settled and d.ret is not null)::int                        as flat_bets,
           sum(d.pl_dollars) filter (where d.settled)                                          as pl_dollars,
           sum(d.stake_dollars) filter (where d.settled)                                       as staked_dollars,
           sum(d.pl_units) filter (where d.settled)                                            as pl_units,
           sum(d.stake_units) filter (where d.settled)                                         as staked_units,
           sum(d.ret) filter (where d.settled)                                                 as flat_pl,
           count(*) filter (where d.clv_status = 'captured')::int                              as clv_bets,
           avg(d.clv_pct) filter (where d.clv_status = 'captured')                             as avg_clv,
           count(*) filter (where d.clv_status = 'captured' and d.clv_pct > 0)::int            as beat_close,
           count(*) filter (where d.clv_status = 'no_close')::int                              as no_close,
           md5(string_agg(d.bet_ref, ',' order by d.bet_ref) filter (where d.settled))         as set_hash
      from d group by d.dim, d.val
  ), based as (
    select a.*,
           case when a.bets > 0 and a.dollars_bets = a.bets and coalesce(a.staked_dollars, 0) > 0 then 'dollars'
                when a.bets > 0 and a.units_bets = a.bets and coalesce(a.staked_units, 0) > 0 then 'units'
                when a.bets > 0 and a.flat_bets = a.bets then 'flat' end as basis
      from agg a
  ), ret as (
    select x.*,
           case x.basis when 'dollars' then x.pl_dollars / x.staked_dollars when 'units' then x.pl_units / x.staked_units
                        when 'flat' then x.flat_pl / x.bets end as ret
      from based x
  ), lab as (
    select y.*, public.fairline_label(y.bets, y.clv_bets, y.ret, y.avg_clv) as label,
           case when y.dim in ('odds', 'lead', 'stake')
                then coalesce((select o.n from jsonb_array_elements(r -> (y.dim || '_buckets')) with ordinality o(e, n)
                                where o.e ->> 'key' = y.val), case y.val when 'live' then 90 else 99 end)
                else 0 end::int as ord
      from ret y
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'dim', l.dim, 'val', l.val, 'ord', l.ord,
           'bets', l.bets, 'pending', l.pending, 'wins', l.wins, 'losses', l.losses, 'pushes', l.pushes, 'cashouts', l.cashouts,
           'pl_dollars', round(l.pl_dollars, 2), 'staked_dollars', round(l.staked_dollars, 2), 'dollars_bets', l.dollars_bets,
           'pl_units', round(l.pl_units, 2), 'staked_units', round(l.staked_units, 2), 'units_bets', l.units_bets,
           'roi_basis', l.basis, 'roi_pct', round(100 * l.ret, 1),
           'pl_basis_value', round(case l.basis when 'dollars' then l.pl_dollars when 'units' then l.pl_units when 'flat' then l.flat_pl end, 2),
           'clv_bets', l.clv_bets, 'avg_clv_pct', round(l.avg_clv, 2), 'beat_close', l.beat_close,
           'beat_close_pct', round(100.0 * l.beat_close / nullif(l.clv_bets, 0), 1), 'no_close', l.no_close,
           'small_sample', l.bets < (r ->> 'min_sample_bets')::int,
           'label', l.label,
           'label_basis', case when l.label in ('real_leak', 'bad_luck', 'running_hot', 'real_edge') then 'clv'
                               when l.label in ('losing', 'winning') then 'pl_only' end,
           'set_hash', l.set_hash)
         order by l.dim, l.ord, l.bets desc, l.val), '[]'::jsonb)
    into v_out
    from lab l;
  return v_out;
end;
$$;

-- What the page shows. Paid: every slice, the three biggest real leaks
-- (largest loss in the slice's own measure first; a slice holding exactly the
-- same bets as one already listed is not listed twice). Free: the name of the
-- biggest leak's slice and nothing else — no count, no money, no CLV.
create or replace function public.fairline_leaks()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  r jsonb := public.fairline_rules();
  v_paid boolean;
  v_slices jsonb;
  v_top jsonb;
  v_overall jsonb;
  v_counts jsonb;
  v_enough boolean;
begin
  if v_user is null then raise exception 'fairline: sign in first' using errcode = '42501'; end if;
  v_paid := public.fairline_paid(v_user, now());
  v_slices := public.fairline_slices_for(v_user);
  select coalesce(jsonb_agg(t.s order by t.n), '[]'::jsonb) into v_top
    from (select distinct on (s ->> 'set_hash') s, (s ->> 'pl_basis_value')::numeric as n
            from jsonb_array_elements(v_slices) s
           where s ->> 'dim' <> 'all' and s ->> 'label' = 'real_leak'
           order by s ->> 'set_hash', (s ->> 'pl_basis_value')::numeric, s ->> 'dim', s ->> 'val') t;
  v_top := coalesce((select jsonb_agg(e order by n) from jsonb_array_elements(v_top) with ordinality x(e, n)
                      where n <= (r ->> 'top_leaks')::int), '[]'::jsonb);
  v_enough := exists (select 1 from jsonb_array_elements(v_slices) s where s ->> 'dim' <> 'all' and not (s ->> 'small_sample')::boolean);

  if not v_paid then
    return jsonb_build_object('paid', false, 'rules', jsonb_build_object('min_sample_bets', r -> 'min_sample_bets'),
      'teaser', case when jsonb_array_length(v_top) > 0
                     then jsonb_build_object('state', 'leak', 'dim', v_top -> 0 ->> 'dim', 'val', v_top -> 0 ->> 'val')
                     when v_enough then jsonb_build_object('state', 'no_leak')
                     else jsonb_build_object('state', 'not_enough_bets') end);
  end if;

  select s - 'set_hash' into v_overall from jsonb_array_elements(v_slices) s where s ->> 'dim' = 'all';
  select jsonb_build_object('bets', count(*), 'settled', count(*) filter (where b.settled),
           'bet_checker', count(*) filter (where b.source = 'bet_checker'), 'portfolio', count(*) filter (where b.source = 'portfolio'),
           'both', count(*) filter (where b.source = 'both'), 'with_clv', count(*) filter (where b.clv_status = 'captured'),
           'dollars_from_unit_size', count(*) filter (where b.dollars_basis = 'unit_size'))
    into v_counts from public.fairline_bets_for(v_user) b;
  return jsonb_build_object('paid', true, 'as_of', now(),
    'rules', jsonb_build_object('version', r -> 'version', 'min_sample_bets', r -> 'min_sample_bets', 'min_clv_bets', r -> 'min_clv_bets',
                                'odds_buckets', r -> 'odds_buckets', 'lead_buckets', r -> 'lead_buckets', 'stake_buckets', r -> 'stake_buckets'),
    'counts', v_counts,
    'overall', v_overall,
    'top_leaks', coalesce((select jsonb_agg(e - 'set_hash') from jsonb_array_elements(v_top) e), '[]'::jsonb),
    'slices', coalesce((select jsonb_agg(e - 'set_hash') from jsonb_array_elements(v_slices) e where e ->> 'dim' <> 'all'), '[]'::jsonb));
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. THE BOARD
-- ─────────────────────────────────────────────────────────────────────────────
-- Every game capture has, starting within board_days_ahead, one row per market
-- and side, at the side's main line (the line most books hang; the most-seen
-- row when none is marked). Game markets only: h2h, spreads, totals.
--
--   fair        signals.sharp_fair, as a probability and as fair American odds
--   best        the best book_quotes price for the row where capture wrote
--               any (actionable lines only, today), else signals.best_dec /
--               best_book. With p_book: that book's price, and only rows that
--               have one.
--   edge_pts    fair probability - the best price's implied probability, in
--               points (+ = the price is better than fair)
--   age         how old the price is now: its age at capture plus the time
--               since. Past the freshness limit (fairline_fresh_limit_min) the
--               row is stale: greyed out and sorted after every fresh row.
--   kalshi      where the game winner is linked: the Kalshi YES mid and ask,
--               only when kalshi_card_current's state is OK; else its state.
--   DK Predictions has no data source: the answer says the column is
--               inactive, and no number is ever sent for it.
--
-- Sorted fresh first, then by edge, largest first. Paid: every row (to
-- board_max_rows), filtered by sport key, market (spread | total | moneyline)
-- and book. Free: the top free_board_rows fresh rows of the whole board,
-- filters ignored, and the count of the rest.
create or replace function public.fairline_board(p_sport text default null, p_market text default null, p_book text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  r jsonb := public.fairline_rules();
  v_user uuid := auth.uid();
  v_paid boolean;
  v_bq boolean := to_regclass('public.book_quotes') is not null;
  v_kc boolean := to_regclass('public.kalshi_card_current') is not null;
  v_sport text;
  v_mkt text;
  v_book text;
  v_sql text;
  v_rows jsonb;
  v_kalshi_ok boolean := false;
begin
  if v_user is null and not public.bet_checker_trusted() then
    raise exception 'fairline: sign in first' using errcode = '42501';
  end if;
  v_paid := public.bet_checker_trusted() or public.fairline_paid(v_user, now());
  -- a free account's board is the whole board: its filters are ignored
  if v_paid then
    v_sport := nullif(btrim(coalesce(p_sport, '')), '');
    v_mkt := case lower(btrim(coalesce(p_market, ''))) when 'spread' then 'spreads' when 'total' then 'totals' when 'moneyline' then 'h2h' end;
    v_book := nullif(btrim(coalesce(p_book, '')), '');
  end if;

  v_sql := $q$
    with base as (
      select distinct on (s.event_id, s.market, s.selection)
             s.sig_key, s.event_id, s.sport_key, coalesce(s.sport_title, s.sport_key) as sport, s.commence_time, s.home_team, s.away_team,
             s.market, s.selection, s.point, s.sharp_fair, s.last_seen_at, s.best_dec, s.best_book, s.best_quote_age_s
        from public.signals s
       where s.market in ('h2h', 'spreads', 'totals')
         and s.commence_time > now() and s.commence_time <= now() + make_interval(days => $1)
         and s.sharp_fair > 0 and s.sharp_fair < 1
         and s.event_id is not null and s.home_team is not null and s.away_team is not null
         and ($2::text is null or s.sport_key = $2)
         and ($3::text is null or s.market = $3)
       order by s.event_id, s.market, s.selection, coalesce(s.point_is_modal, false) desc, s.last_seen_at desc nulls last, s.sig_key
    ), priced as (
      select b.*, q.dec as q_dec, q.book as q_book, q.age_s as q_age, q.src as q_src
        from base b
        left join lateral (
          select x.dec, x.book, x.age_s, x.src from (
            %1$s
            select b.best_dec as dec, b.best_book as book,
                   coalesce(b.best_quote_age_s, 0) + extract(epoch from (now() - b.last_seen_at)) as age_s, 'signals'::text as src, 2 as pr
             where b.best_dec > 1 and ($4::text is null or lower(b.best_book) = lower($4))
          ) x
          order by x.pr, x.dec desc, x.age_s
          limit 1) q on true
    ), kal as (
      select p.*, kc.k_state, kc.k_mid, kc.k_ask, kc.k_at
        from priced p
        left join lateral (%2$s) kc on true
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'sig_key', k.sig_key, 'event_id', k.event_id, 'sport_key', k.sport_key, 'sport', k.sport, 'commence_time', k.commence_time,
             'home_team', k.home_team, 'away_team', k.away_team,
             'market', case k.market when 'spreads' then 'spread' when 'totals' then 'total' else 'moneyline' end,
             'selection', k.selection, 'point', case when k.market = 'h2h' then null else k.point end,
             'fair_prob', round(k.sharp_fair, 4), 'fair_american', public.bet_checker_prob_to_american(k.sharp_fair),
             'best_dec', round(k.q_dec, 4), 'best_american', public.portfolio_decimal_to_american(k.q_dec), 'best_book', k.q_book,
             'best_source', k.q_src,
             'edge_pts', case when k.q_dec > 1 then round((k.sharp_fair - 1 / k.q_dec) * 100, 2) end,
             'quote_age_min', round(k.q_age / 60.0, 1),
             'fresh_limit_min', k.lim,
             'fresh', coalesce(k.q_dec > 1 and k.q_age / 60.0 <= k.lim, false),
             'kalshi_state', k.k_state, 'kalshi_mid', k.k_mid, 'kalshi_ask', k.k_ask, 'kalshi_at', k.k_at)
           order by coalesce(k.q_dec > 1 and k.q_age / 60.0 <= k.lim, false) desc, (k.sharp_fair - 1 / nullif(k.q_dec, 0)) desc nulls last,
                    k.commence_time, k.sig_key), '[]'::jsonb)
      from (select kal.*, public.fairline_fresh_limit_min(kal.sport_key, extract(epoch from (kal.commence_time - now())) / 3600.0) as lim
              from kal where kal.q_dec is not null or $4::text is null) k
  $q$;

  -- the per-book quotes, where capture wrote any
  v_sql := replace(v_sql, '%1$s', case when v_bq then
    $bq$ select bq.dec, coalesce(bq.book_title, bq.book_key) as book,
              coalesce(bq.quote_age_s, 0) + extract(epoch from (now() - bq.updated_at)) as age_s, 'book_quotes'::text as src, 1 as pr
         from public.book_quotes bq
        where bq.sig_key = b.sig_key and bq.dec > 1 and coalesce(bq.is_fresh, true)
          and ($4::text is null or lower(coalesce(bq.book_title, bq.book_key)) = lower($4) or lower(bq.book_key) = lower($4))
       union all $bq$ else '' end);

  begin
    if v_kc then
      execute replace(v_sql, '%2$s',
        $kc$ select c.state as k_state, case when c.state = 'OK' then c.yes_mid end as k_mid,
                    case when c.state = 'OK' then c.yes_ask end as k_ask, case when c.state = 'OK' then c.snapshot_at end as k_at
               from public.kalshi_card_current c
              where p.market = 'h2h' and c.odds_event_id = p.event_id and c.yes_team = p.selection
              order by c.snapshot_at desc nulls last limit 1 $kc$)
        into v_rows using (r ->> 'board_days_ahead')::int, v_sport, v_mkt, v_book;
      v_kalshi_ok := true;
    end if;
  exception when others then
    v_rows := null;   -- a Kalshi layer this file does not know: the board without it, never an error
  end;
  if not v_kalshi_ok then
    execute replace(v_sql, '%2$s', $nk$ select null::text as k_state, null::numeric as k_mid, null::numeric as k_ask, null::timestamptz as k_at $nk$)
      into v_rows using (r ->> 'board_days_ahead')::int, v_sport, v_mkt, v_book;
  end if;

  return jsonb_build_object(
    'paid', v_paid, 'as_of', now(),
    'rules', jsonb_build_object('version', r -> 'version', 'board_days_ahead', r -> 'board_days_ahead',
                                'freshness_hours', r -> 'freshness_hours', 'freshness_min', r -> 'freshness_min'),
    'coverage', jsonb_build_object('book_quotes', v_bq, 'kalshi', v_kalshi_ok),
    'inactive', jsonb_build_array(jsonb_build_object('column', 'dk_predictions', 'label', 'DK Predictions', 'state', 'coming_soon',
                                                     'reason', 'no_price_feed')),
    'total_rows', jsonb_array_length(v_rows),
    'fresh_rows', (select count(*) from jsonb_array_elements(v_rows) e where (e ->> 'fresh')::boolean),
    'filters', case when v_paid then jsonb_build_object('sport', v_sport, 'market', p_market, 'book', v_book, 'locked', false)
                    else jsonb_build_object('locked', true) end,
    'truncated', v_paid and jsonb_array_length(v_rows) > (r ->> 'board_max_rows')::int,
    'facets', case when v_paid then jsonb_build_object(
                'sports', coalesce((select jsonb_agg(distinct jsonb_build_object('key', e ->> 'sport_key', 'label', e ->> 'sport')) from jsonb_array_elements(v_rows) e), '[]'::jsonb),
                'books', coalesce((select jsonb_agg(distinct e ->> 'best_book') from jsonb_array_elements(v_rows) e where e ->> 'best_book' is not null), '[]'::jsonb))
              end,
    'rows', case when v_paid
                 then coalesce((select jsonb_agg(e order by n) from jsonb_array_elements(v_rows) with ordinality x(e, n)
                                 where n <= (r ->> 'board_max_rows')::int), '[]'::jsonb)
                 else coalesce((select jsonb_agg(e order by n) from jsonb_array_elements(v_rows) with ordinality x(e, n)
                                 where (e ->> 'fresh')::boolean and n <= (r ->> 'free_board_rows')::int), '[]'::jsonb) end,
    'hidden_rows', case when v_paid then greatest(jsonb_array_length(v_rows) - (r ->> 'board_max_rows')::int, 0)
                        else greatest(jsonb_array_length(v_rows) - (select count(*) from jsonb_array_elements(v_rows) with ordinality x(e, n)
                                                                     where (e ->> 'fresh')::boolean and n <= (r ->> 'free_board_rows')::int)::int, 0) end);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. GRANTS
-- ─────────────────────────────────────────────────────────────────────────────
-- A Supabase project grants EXECUTE on every new public function to anon and
-- authenticated by default; revoking from PUBLIC alone leaves those in place.
revoke all on function public.fairline_paid(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.fairline_bets_for(uuid) from public, anon, authenticated;
revoke all on function public.fairline_slices_for(uuid) from public, anon, authenticated;
revoke all on function public.fairline_my_bets() from public, anon;
revoke all on function public.fairline_leaks() from public, anon;
revoke all on function public.fairline_board(text, text, text) from public, anon;
revoke all on public.fairline_bets from public, anon, authenticated;
grant execute on function public.fairline_my_bets(), public.fairline_leaks(), public.fairline_board(text, text, text) to authenticated;
grant select on public.fairline_bets to authenticated;
grant execute on function public.fairline_rules() to anon, authenticated;
do $g$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.fairline_paid(uuid, timestamptz), public.fairline_bets_for(uuid), '
         || 'public.fairline_slices_for(uuid), public.fairline_board(text, text, text), public.fairline_rules() to service_role';
  end if;
end
$g$;

notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- THE REPORT. Every row should say ok.
-- ─────────────────────────────────────────────────────────────────────────────
select piece, state from (
  select '01 every Fairline door calls the one gate, fairline_paid()' as piece,
         case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public' and p.proname in ('fairline_my_bets', 'fairline_leaks', 'fairline_board')
                       and pg_get_functiondef(p.oid) like '%public.fairline_paid(%') = 3
              then 'ok (fairline_paid -> ' || case when pg_get_functiondef('public.fairline_paid(uuid,timestamptz)'::regprocedure) like '%has_bet_checker_paid%'
                                                    then 'has_bet_checker_paid' else 'another rule' end || ')'
              else 'CHECK THIS' end as state
  union all select '02 signals RLS is untouched (The Board is a definer door, not a policy)',
         case when not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'signals' and policyname like 'fairline%')
              then 'ok' else 'CHECK THIS' end
  union all select '03 only the caller or the service role reads one account''s bets or leaks',
         case when not has_function_privilege('authenticated', 'public.fairline_bets_for(uuid)', 'execute')
               and not has_function_privilege('anon', 'public.fairline_bets_for(uuid)', 'execute')
               and not has_function_privilege('authenticated', 'public.fairline_slices_for(uuid)', 'execute')
               and not has_function_privilege('authenticated', 'public.fairline_paid(uuid,timestamptz)', 'execute')
              then 'ok' else 'CHECK THIS' end
  union all select '04 anon reads no bet, no leak and no board',
         case when not has_function_privilege('anon', 'public.fairline_my_bets()', 'execute')
               and not has_function_privilege('anon', 'public.fairline_leaks()', 'execute')
               and not has_function_privilege('anon', 'public.fairline_board(text,text,text)', 'execute')
               and not has_table_privilege('anon', 'public.fairline_bets', 'select')
              then 'ok' else 'CHECK THIS' end
  union all select '05 the label follows the one constant, fairline_rules()',
         case when public.fairline_label((public.fairline_rules() ->> 'min_sample_bets')::int - 1, 99, -0.1, -1) is null
               and public.fairline_label((public.fairline_rules() ->> 'min_sample_bets')::int, (public.fairline_rules() ->> 'min_clv_bets')::int, -0.1, -1) = 'real_leak'
               and public.fairline_label((public.fairline_rules() ->> 'min_sample_bets')::int, (public.fairline_rules() ->> 'min_clv_bets')::int, -0.1, 1) = 'bad_luck'
               and public.fairline_label((public.fairline_rules() ->> 'min_sample_bets')::int, (public.fairline_rules() ->> 'min_clv_bets')::int, 0.1, -1) = 'running_hot'
               and public.fairline_label((public.fairline_rules() ->> 'min_sample_bets')::int, (public.fairline_rules() ->> 'min_clv_bets')::int, 0.1, 1) = 'real_edge'
               and public.fairline_label((public.fairline_rules() ->> 'min_sample_bets')::int, 0, -0.1, null) = 'losing'
              then 'ok (a label from ' || (public.fairline_rules() ->> 'min_sample_bets') || ' settled bets)' else 'CHECK THIS' end
  union all select '06 the odds ranges meet with no gap',
         case when public.fairline_odds_bucket(-200) = 'le_m200' and public.fairline_odds_bucket(-199) = 'm199_m121'
               and public.fairline_odds_bucket(-121) = 'm199_m121' and public.fairline_odds_bucket(-120) = 'm120_p120'
               and public.fairline_odds_bucket(100) = 'm120_p120' and public.fairline_odds_bucket(120) = 'm120_p120'
               and public.fairline_odds_bucket(121) = 'p121_p200' and public.fairline_odds_bucket(200) = 'p121_p200'
               and public.fairline_odds_bucket(201) = 'gt_p200'
              then 'ok' else 'CHECK THIS' end
  union all select '07 the board knows its sources',
         'ok (book_quotes ' || case when to_regclass('public.book_quotes') is not null then 'present' else 'absent: signals best price only' end
         || ', Kalshi ' || case when to_regclass('public.kalshi_card_current') is not null then 'present' else 'absent' end || ')'
  union all select '08 upcoming board rows with a fair price',
         'ok (' || (select count(*) from public.signals s where s.market in ('h2h', 'spreads', 'totals') and s.commence_time > now()
                     and s.commence_time <= now() + make_interval(days => (public.fairline_rules() ->> 'board_days_ahead')::int)
                     and s.sharp_fair > 0 and s.sharp_fair < 1)::text || ')'
  union all select '09 bets on file (Bet Checker, Portfolio)',
         'ok (' || (select count(*) from public.user_bets where status = 'open')::text || ', '
                || (select count(*) from public.portfolio_positions where status <> 'VOID')::text || ')'
) r order by 1;
