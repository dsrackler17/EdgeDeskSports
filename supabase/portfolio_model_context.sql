-- =============================================================================
-- portfolio_model_context.sql — what EdgeDesk's own model said about a
-- reader's sportsbook bet, BEFORE the bet was placed, where the bet can be
-- matched to the model's record reliably. Over supabase/portfolio.sql and
-- supabase/model_pnl.sql + model_pnl_analytics.sql (model_pnl_public, the
-- record's public view).
--
-- WHAT IT ANSWERS, for one position (portfolio_model_context(id)):
--   the accepted price and the probability it implies (the book's margin
--   included); EdgeDesk's probability for the bettor's side and its fair
--   line, AS RECORDED BEFORE placed_at; the difference between the two; the
--   closing-line value where a timestamped close exists; the outcome and the
--   realized return.
--
-- WHAT IT NEVER DOES
--   - present a model number made AFTER the bet as if it existed before it
--     (a record made later is reported as MODEL_AFTER_PLACEMENT, not shown);
--   - guess a match: football singles only (moneyline, spread, total), both
--     teams must match in the same league, kickoff within 6 hours, one game
--     only; anything else says why it was not matched;
--   - give a probability for a different line than the one the model
--     priced (a spread or total at another number shows the fair line only);
--   - change the position, its attribution or any P&L. The bettor's results
--     and the model's results stay separate; this is read-only context.
--   A record EdgeDesk recovered from its published history (git) rather than
--   captured live is labelled RECONSTRUCTED, never presented as live.
--
-- Runs as the caller (security invoker): the position must be the reader's
-- own (row level security), and model_pnl_public is EdgeDesk's public
-- record (anon can read it already). Idempotent, additive, ends in a report.
-- =============================================================================

do $$ begin
  if to_regclass('public.portfolio_positions') is null then
    raise exception 'portfolio_model_context: run supabase/portfolio.sql first';
  end if;
end $$;

-- A team as the model names it, against a team as a book names it: equal
-- once normalized; or the school name followed by ONE word (its mascot:
-- "Texas" = "Texas Longhorns", never "Texas Tech Red Raiders"); or, in the
-- NFL only, the nickname alone ("Jets" = "New York Jets").
create or replace function public.portfolio_team_match(p_model text, p_book text, p_league text)
returns boolean language sql immutable as $$
  with n as (select public.portfolio_norm_text(p_model) as m, public.portfolio_norm_text(p_book) as b)
  select coalesce(m <> '' and b <> '' and (
      m = b
      or (left(b, length(m) + 1) = m || ' ' and position(' ' in substr(b, length(m) + 2)) = 0)
      or (left(m, length(b) + 1) = b || ' ' and position(' ' in substr(m, length(b) + 2)) = 0)
      or (upper(coalesce(p_league, '')) = 'NFL' and (m like '% ' || b) and position(' ' in b) = 0)
    ), false) from n
$$;

-- The two teams of a book's event name ("Away at Home", "Away @ Home",
-- "A vs B"), and whether their order is known.
create or replace function public.portfolio_event_teams(p_event text)
returns table (away text, home text, ordered boolean) language sql immutable as $$
  select btrim(m[1]), btrim(m[3]), m[2] <> 'vs'
    from (select regexp_match(coalesce(p_event, ''), '^\s*(.+?)\s+(at|@|vs\.?)\s+(.+?)\s*$', 'i') as m) q
   where m is not null
$$;

create or replace function public.portfolio_model_context(p_position uuid)
returns jsonb language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  p record; t record; mkt text; lg text; side_kind text; my_team text; dec_price numeric; implied numeric;
  games text[]; m record; later int; prob numeric; prob_basis text; close_dec numeric; out jsonb;
begin
  select * into p from public.portfolio_positions where id = p_position;
  if not found then raise exception 'portfolio: no such position' using errcode = 'P0002'; end if;
  dec_price := p.odds_decimal;
  implied := case when dec_price > 1 then round(1 / dec_price, 6) end;
  out := jsonb_build_object('position_id', p.id, 'accepted_odds_american', p.odds_american, 'accepted_odds_decimal', p.odds_decimal,
    'market_implied_probability', implied, 'outcome', p.result, 'status', p.status, 'profit_loss', p.profit_loss,
    'realized_return', case when p.status <> 'OPEN' and p.cost_basis > 0 then round(p.profit_loss / p.cost_basis, 6) end);
  if to_regclass('public.model_pnl_public') is null then
    return out || jsonb_build_object('matched', false, 'reason', 'MODEL_RECORD_NOT_INSTALLED');
  end if;
  if p.platform_type <> 'SPORTSBOOK' or p.position_type not in ('MONEYLINE', 'SPREAD', 'TOTAL') or jsonb_array_length(coalesce(p.legs, '[]'::jsonb)) > 1 then
    return out || jsonb_build_object('matched', false, 'reason', 'NOT_A_SINGLE_GAME_LINE');
  end if;
  lg := case when upper(coalesce(p.sport, '')) in ('NFL', 'CFB') then upper(p.sport)
             when upper(coalesce(p.league, '')) = 'NFL' then 'NFL'
             when upper(coalesce(p.league, '')) in ('NCAAF', 'CFB', 'COLLEGE FOOTBALL', 'NCAA FOOTBALL') then 'CFB' end;
  if lg is null then return out || jsonb_build_object('matched', false, 'reason', 'NOT_IN_THE_MODEL_RECORD'); end if;
  select * into t from public.portfolio_event_teams(p.event_name);
  if not found then return out || jsonb_build_object('matched', false, 'reason', 'TEAMS_NOT_READABLE'); end if;
  mkt := lower(p.position_type);
  side_kind := case when p.position_type = 'TOTAL' then lower(split_part(btrim(coalesce(nullif(p.side, ''), p.selection)), ' ', 1)) end;
  if p.position_type = 'TOTAL' and side_kind not in ('over', 'under') then
    return out || jsonb_build_object('matched', false, 'reason', 'SIDE_NOT_READABLE');
  end if;
  my_team := case when p.position_type <> 'TOTAL' then coalesce(nullif(btrim(p.side), ''),
               btrim(regexp_replace(p.selection, '\s*([+-]?\d+(\.\d+)?|ML|moneyline)\s*$', '', 'i'))) end;
  -- the one game: both teams, the same league, the kickoff (or, with none
  -- recorded on the bet, a game in the week after it was placed)
  select array_agg(distinct r.event_id) into games from public.model_pnl_public r
   where r.league = lg and r.market_group = 'game'
     and ((public.portfolio_team_match(r.away, t.away, lg) and public.portfolio_team_match(r.home, t.home, lg))
       or (not t.ordered and public.portfolio_team_match(r.away, t.home, lg) and public.portfolio_team_match(r.home, t.away, lg)))
     and (case when p.event_start_at is not null then abs(extract(epoch from (r.game_date - p.event_start_at))) <= 6 * 3600
               else r.game_date between p.placed_at and p.placed_at + interval '7 days' end);
  if coalesce(array_length(games, 1), 0) = 0 then return out || jsonb_build_object('matched', false, 'reason', 'NO_MODEL_RECORD_FOR_THIS_GAME'); end if;
  if array_length(games, 1) > 1 then return out || jsonb_build_object('matched', false, 'reason', 'MORE_THAN_ONE_GAME_MATCHES'); end if;
  -- the model's record of that market, made BEFORE the bet
  select r.recommendation_id, r.event_label, r.game_date, r.market_type, r.side, r.team, r.selection, r.model_line, r.model_prob, r.entry_line,
         r.recommended_at, r.model_version, r.evaluation_mode, r.home, r.away
    into m from public.model_pnl_public r
   where r.event_id = games[1] and r.league = lg and r.market_type = mkt and r.market_group = 'game'
     and r.recommended_at is not null and r.recommended_at < p.placed_at
   order by r.recommended_at desc limit 1;
  if not found then
    select count(*) into later from public.model_pnl_public r where r.event_id = games[1] and r.league = lg and r.market_type = mkt and r.market_group = 'game';
    return out || jsonb_build_object('matched', false, 'reason', case when later > 0 then 'MODEL_AFTER_PLACEMENT' else 'NO_MODEL_RECORD_FOR_THIS_MARKET' end);
  end if;
  -- the bettor's side against the model's: the same side, or (a two-way
  -- market) the other one, whose probability is the complement — and only
  -- at the line the model priced
  prob := null; prob_basis := null;
  if m.model_prob is not null and (p.position_type = 'MONEYLINE' or (p.line is not null and m.entry_line is not null and abs(p.line) = abs(m.entry_line))) then
    if (p.position_type = 'TOTAL' and lower(m.side) = side_kind)
       or (p.position_type <> 'TOTAL' and public.portfolio_team_match(coalesce(m.team, case lower(m.side) when 'home' then m.home when 'away' then m.away end), my_team, lg)) then
      prob := m.model_prob; prob_basis := 'THE_MODELS_SIDE';
    elsif (p.position_type = 'TOTAL' and lower(m.side) in ('over', 'under'))
       or (p.position_type <> 'TOTAL' and (public.portfolio_team_match(m.home, my_team, lg) or public.portfolio_team_match(m.away, my_team, lg))) then
      prob := round(1 - m.model_prob, 6); prob_basis := 'COMPLEMENT_OF_THE_MODELS_SIDE';
    end if;
  end if;
  -- closing-line value from the reader's own recorded close (the journal)
  select closing_odds_decimal into close_dec from public.portfolio_journal_entries where position_id = p.id;
  return out || jsonb_build_object('matched', true, 'reason', null,
    'model', jsonb_build_object('record_id', m.recommendation_id, 'game', m.event_label, 'kickoff', m.game_date, 'market', m.market_type, 'model_side', m.selection,
      'fair_line', m.model_line, 'priced_line', m.entry_line, 'model_version', m.model_version, 'recorded_at', m.recommended_at,
      'evidence', case when m.evaluation_mode = 'LIVE' then 'LIVE' else 'RECONSTRUCTED' end,
      'recorded_before_bet_by_seconds', floor(extract(epoch from (p.placed_at - m.recommended_at)))),
    'edgedesk_probability', prob, 'probability_basis', prob_basis,
    'model_market_difference', case when prob is not null and implied is not null then round(prob - implied, 6) end,
    'clv', case when close_dec > 1 and dec_price > 1 then jsonb_build_object('source', 'JOURNAL_CLOSE', 'pct', round(dec_price / close_dec - 1, 6)) end);
end $$;

revoke all on function public.portfolio_model_context(uuid), public.portfolio_team_match(text, text, text), public.portfolio_event_teams(text) from public, anon;
grant execute on function public.portfolio_model_context(uuid), public.portfolio_team_match(text, text, text), public.portfolio_event_teams(text) to authenticated, service_role;

notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- THE REPORT. Every row should read ok.
-- ─────────────────────────────────────────────────────────────────────────────
select step, item, outcome from (
  select 1 as step, 'the model context runs as the caller, closed to anon' as item,
    case when not (select prosecdef from pg_proc where oid = 'public.portfolio_model_context(uuid)'::regprocedure)
      and not has_function_privilege('anon', 'public.portfolio_model_context(uuid)', 'execute') then 'ok' else 'CHECK THIS' end as outcome
  union all select 2, 'team matching: Texas = Texas Longhorns, Texas ≠ Texas Tech Red Raiders, Jets = New York Jets in the NFL only',
    case when public.portfolio_team_match('Texas', 'Texas Longhorns', 'CFB') and not public.portfolio_team_match('Texas', 'Texas Tech Red Raiders', 'CFB')
      and public.portfolio_team_match('New York Jets', 'Jets', 'NFL') and not public.portfolio_team_match('Miami (OH)', 'Miami Hurricanes', 'CFB')
      and not public.portfolio_team_match('Tigers', 'Clemson Tigers', 'CFB') then 'ok' else 'CHECK THIS' end
  union all select 3, 'the model record this reads is installed (supabase/model_pnl_analytics.sql)',
    case when to_regclass('public.model_pnl_public') is not null then 'ok' else 'CHECK THIS — no match is possible until it is' end
) r order by 1;
