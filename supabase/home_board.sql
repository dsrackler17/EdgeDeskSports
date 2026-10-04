-- =============================================================================
-- home_board — what the landing page's live board may show a signed-out
-- visitor: the current slate, as EdgeDesk has it right now.
--
-- WHAT IT IS
--   public_home_board()   ONE anonymous call for the landing page's hero
--                         statistics, its live research preview and its
--                         "Today on EdgeDesk" board:
--                           counts   games analyzed, game-market research,
--                                    watching, passes, data incomplete, player
--                                    props tracked, player-prop research,
--                                    sportsbook quotes, sportsbooks
--                           times    last model update, last odds update
--                           games    at most 8 upcoming games, research first,
--                                    each with the fair and market numbers,
--                                    the gap, the public status, the market's
--                                    book and capture time, reliability, what
--                                    is uncertain, and at most 3 research-grade
--                                    player props with their price, capture
--                                    time, projection, probability and EV
--                         It is a SUBSET of the shared research state
--                         (personal_research.sql game_research_state): the
--                         full board, every driver, line movement, the
--                         priority ranking's reasoning, the watchlist and
--                         everything personal never leave the database.
--   public_home_board_cache  one row: the last answer and when it was
--                         built. A call inside 60 seconds of the last build
--                         reads the row instead of the table, so a traffic
--                         spike from one post costs one query a minute, not
--                         one per visitor. Current odds are never older than
--                         the research state itself plus that minute.
--
-- THE PUBLIC STATUS — four words, never BET / LOCK / PICK:
--   RESEARCH         the game clears EdgeDesk's research gates (the state's
--                    own research_grade: a priority-eligible GAME signal)
--   WATCH            a real disagreement the gates have not cleared (NFL/CFB
--                    INVESTIGATE, a gap of 2+ points below the bar)
--   PASS             EdgeDesk and a current market agree (under 2 points)
--   DATA INCOMPLETE  not priced, no current market, a stale capture, thin
--                    data or a data fault — and it says which
-- It is a relabelling of fields the research state already carries; nothing
-- is computed here that the football module did not compute.
--
-- NOTHING IS INVENTED. A game with no projection says so; a market with no
-- capture time is not called current; a state older than 3 hours is marked
-- stale; an empty slate returns empty lists and the page hides the section.
--
-- RUN ORDER. personal_research.sql first (the research state lives there).
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

do $guard$
begin
  if to_regclass('public.game_research_state') is null or to_regprocedure('public.edgedesk_proof_metrics()') is null then
    raise exception 'Run supabase/personal_research.sql first (the research state and the proof metrics live there).';
  end if;
end
$guard$;

create table if not exists public.public_home_board_cache (
  id        int primary key default 1 check (id = 1),
  payload   jsonb not null,
  built_at  timestamptz not null default now()
);
alter table public.public_home_board_cache enable row level security;
revoke all on public.public_home_board_cache from anon, authenticated;

-- the four public words, from the state's own fields
create or replace function public.ed_public_status(
  p_projected boolean, p_status text, p_research_label text, p_research_grade boolean,
  p_market_line numeric, p_market_stale boolean, p_gap numeric)
returns text language sql immutable as $$
  select case
    when not coalesce(p_projected, false) then 'DATA_INCOMPLETE'
    when upper(coalesce(p_status, '')) in ('DATA FAULT', 'NOT PRICED', 'AWAITING DATA', 'THIN DATA', 'STALE QUOTE', 'NO MARKET')
      or upper(coalesce(p_research_label, '')) in ('DATA_FAULT', 'LIMITED_DATA', 'NO_MARKET', 'LOW_RELIABILITY') then 'DATA_INCOMPLETE'
    when p_market_line is null or coalesce(p_market_stale, false) then 'DATA_INCOMPLETE'
    when coalesce(p_research_grade, false) then 'RESEARCH'
    when p_gap is not null and p_gap < 2 then 'PASS'
    when upper(coalesce(p_status, '')) = 'AGREEMENT'
      or upper(coalesce(p_research_label, '')) in ('MARKET_ALIGNED', 'NEAR_PICKEM') then 'PASS'
    else 'WATCH' end;
$$;
-- why a game is DATA_INCOMPLETE, in words a visitor can read
create or replace function public.ed_public_incomplete_reason(
  p_projected boolean, p_status text, p_market_line numeric, p_market_stale boolean)
returns text language sql immutable as $$
  select case
    when not coalesce(p_projected, false) or upper(coalesce(p_status, '')) = 'NOT PRICED' then 'EdgeDesk has not priced this game yet.'
    when upper(coalesce(p_status, '')) = 'DATA FAULT' then 'An integrity check flagged the data; the number is held back until it is explained.'
    when p_market_line is null or upper(coalesce(p_status, '')) = 'NO MARKET' then 'No current sportsbook market has been captured.'
    when coalesce(p_market_stale, false) or upper(coalesce(p_status, '')) = 'STALE QUOTE' then 'The last sportsbook price on file is stale.'
    else 'Some inputs are missing or thin for this game.' end;
$$;

-- a player prop from a research state's props block, reduced to what the
-- landing page prints (lib/edgedesk_opportunity.js stateProps is the source)
create or replace function public.ed_public_prop(o jsonb)
returns jsonb language sql immutable as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', o ->> 'id',
    'prop_id', o ->> 'prop_id',
    'league', o ->> 'league',
    'player', jsonb_build_object('name', o #>> '{player,name}', 'team', o #>> '{player,team}', 'position', o #>> '{player,position}'),
    'market', jsonb_build_object('key', o #>> '{market,key}', 'label', o #>> '{market,label}'),
    'selection', jsonb_build_object('side', o #>> '{selection,side}', 'line', o #> '{selection,line}', 'text', o #>> '{selection,text}'),
    'price', jsonb_build_object('american', o #> '{price,american}', 'book', coalesce(o #>> '{price,book_name}', o #>> '{price,book}'),
                                'captured_at', o #>> '{price,captured_at}', 'alt', o #> '{price,alt}', 'books_at_line', o #> '{price,books_at_line}'),
    'projection', jsonb_build_object('mean', o #> '{model,projection,mean}', 'median', o #> '{model,projection,median}',
                                     'p25', o #> '{model,projection,p25}', 'p75', o #> '{model,projection,p75}'),
    'probability', o #> '{model,probability}',
    'fair_american', o #> '{model,fair_american}',
    'break_even', o -> 'break_even',
    'ev', o -> 'ev',
    'ev_raw', o -> 'ev_raw',
    'edge_pp', o -> 'edge_pp',
    'confidence', o -> 'confidence',
    'decision', o ->> 'decision',
    'stage', o ->> 'stage',
    'probability_label', o ->> 'probability_label',
    'consensus_line', o #> '{market_view,consensus_line}',
    'n_books', o #> '{market_view,n_books}',
    'research_score', o #> '{research,score}',
    'research_grade', o #> '{research,grade}',
    'why', (select jsonb_agg(x) from (select x from jsonb_array_elements_text(coalesce(o #> '{explanation,why}', '[]'::jsonb)) x limit 3) q),
    'concerns', (select jsonb_agg(x) from (select x from jsonb_array_elements_text(coalesce(o #> '{explanation,concerns}', '[]'::jsonb)) x limit 3) q),
    'evaluated_at', o ->> 'evaluated_at'));
$$;
revoke all on function public.ed_public_status(boolean, text, text, boolean, numeric, boolean, numeric) from public, anon, authenticated;
revoke all on function public.ed_public_incomplete_reason(boolean, text, numeric, boolean) from public, anon, authenticated;
revoke all on function public.ed_public_prop(jsonb) from public, anon, authenticated;

-- the answer itself, built from the table (internal)
create or replace function public.public_home_board_build()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_metrics jsonb; out jsonb; v_book_quotes int; v_prop_quotes int; v_prop_at timestamptz; v_samples text[] := '{}';
begin
  -- the games an admin has made publicly readable (growth.sql public samples):
  -- only those get a "see the research" link a signed-out visitor can open
  if to_regclass('public.public_sample_games') is not null then
    begin
      execute $q$select coalesce(array_agg(game_key), '{}') from public.public_sample_games
                 where enabled and (expires_at is null or expires_at > now())$q$ into v_samples;
    exception when others then v_samples := '{}';
    end;
  end if;
  begin v_metrics := public.edgedesk_proof_metrics(); exception when others then v_metrics := '{}'::jsonb; end;
  -- every current sportsbook price EdgeDesk holds for upcoming football:
  -- game markets (book_quotes on live signals) and player props
  -- (player_prop_quotes), where those capture tables exist on this project
  if to_regclass('public.book_quotes') is not null and to_regclass('public.signals') is not null then
    begin
      execute $q$select count(*)::int from public.book_quotes bq join public.signals s on s.sig_key = bq.sig_key
                 where s.commence_time > now() and s.last_seen_at > now() - interval '6 hours'
                   and s.sport_key in ('americanfootball_ncaaf','americanfootball_nfl')$q$ into v_book_quotes;
    exception when others then v_book_quotes := null;
    end;
  end if;
  if to_regclass('public.player_prop_quotes') is not null then
    begin
      execute $q$select count(*)::int, max(captured_at) from public.player_prop_quotes
                 where commence_time > now() and captured_at > now() - interval '6 hours'$q$ into v_prop_quotes, v_prop_at;
    exception when others then v_prop_quotes := null; v_prop_at := null;
    end;
  end if;
  with g as (
    select r.*,
           public.ed_public_status(r.projected, r.status, r.research_label, r.research_grade, r.market_home_line, r.market_stale, r.gap_pts) as pub,
           r.state -> 'props' as props
      from public.game_research_state r
     where r.kickoff_at > now() and r.kickoff_at < now() + interval '8 days'
  ), ranked as (
    select g.*, row_number() over (
             order by case pub when 'RESEARCH' then 0 when 'WATCH' then 1 when 'PASS' then 2 else 3 end,
                      coalesce(jsonb_array_length(case when jsonb_typeof(props -> 'top_opportunities') = 'array' then props -> 'top_opportunities' end), 0) > 0 desc,
                      priority_rank nulls last, gap_pts desc nulls last, kickoff_at) as rn
      from g
  )
  select jsonb_build_object(
    'ok', true,
    'schema', 'edgedesk_home_board/1',
    'as_of', now(),
    'counts', jsonb_build_object(
      'games_analyzed', (select count(*) from g where projected),
      'games_on_slate', (select count(*) from g),
      'game_research', (select count(*) from g where pub = 'RESEARCH'),
      'watching', (select count(*) from g where pub = 'WATCH'),
      'passes', (select count(*) from g where pub = 'PASS'),
      'data_incomplete', (select count(*) from g where pub = 'DATA_INCOMPLETE'),
      'nfl_games', (select count(*) from g where sport = 'nfl' and projected),
      'cfb_games', (select count(*) from g where sport = 'cfb' and projected),
      'props_tracked', (select coalesce(sum((props ->> 'total_props')::int), 0) from g where (props ->> 'total_props') ~ '^[0-9]+$'),
      'props_evaluated', (select coalesce(sum((props ->> 'evaluated_props')::int), 0) from g where (props ->> 'evaluated_props') ~ '^[0-9]+$'),
      'prop_research', (select coalesce(sum((props ->> 'count')::int), 0) from g where (props ->> 'count') ~ '^[0-9]+$'),
      'game_market_quotes', to_jsonb(v_book_quotes),
      'prop_quotes', to_jsonb(v_prop_quotes),
      'sportsbook_quotes', case when v_book_quotes is null and v_prop_quotes is null then null
                                else to_jsonb(coalesce(v_book_quotes, 0) + coalesce(v_prop_quotes, 0)) end,
      'market_signals', v_metrics -> 'active_market_quotes',
      'sportsbooks', v_metrics -> 'books_represented'),
    'times', jsonb_build_object(
      'model_updated_at', (select max(computed_at) from g),
      'market_updated_at', (select max(market_captured_at) from g where market_captured_at <= now()),
      'quotes_updated_at', v_metrics -> 'quotes_updated_at',
      'prop_quotes_updated_at', v_prop_at),
    'games', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'game_key', game_key, 'league', sport, 'home', home, 'away', away, 'kickoff_at', kickoff_at,
        'status', pub,
        'status_note', case when pub = 'DATA_INCOMPLETE'
                            then public.ed_public_incomplete_reason(projected, status, market_home_line, market_stale) end,
        'research_label', research_label,
        'fair', jsonb_build_object('home_line', fair_home_line, 'total', fair_total, 'text', state #>> '{fair,text}'),
        'market', jsonb_build_object('home_line', market_home_line, 'total', market_total, 'text', state #>> '{market,text}',
                                     'book', market_book, 'captured_at', market_captured_at, 'stale', market_stale, 'kind', market_kind,
                                     'books', state #> '{market,books}', 'ml_home', state #> '{market,ml_home}', 'ml_away', state #> '{market,ml_away}'),
        'gap', jsonb_build_object('points', gap_pts, 'toward', state #>> '{gap,toward}'),
        'win_prob_home', win_prob_home,
        'reliability', jsonb_build_object('score', reliability_score, 'grade', reliability_grade, 'main_deduction', state #>> '{reliability,main_deduction}'),
        'qb', jsonb_build_object('confirmed_both', qb_confirmed, 'unknown', qb_unknown),
        'key_reason', left(key_reason, 240),
        'uncertainty', (select jsonb_agg(x) from (
                          select x from jsonb_array_elements_text(case when jsonb_typeof(state #> '{priority,uncertainty}') = 'array'
                                                                       then state #> '{priority,uncertainty}' else '[]'::jsonb end) x limit 3) q),
        'props', case when jsonb_typeof(props) = 'object' then jsonb_build_object(
                   'count', props -> 'count', 'total', props -> 'total_props', 'priced', props -> 'priced_props',
                   'evaluated', props -> 'evaluated_props', 'capture', props #>> '{capture,state}',
                   'empty_text', props ->> 'empty_text', 'summary_at', props ->> 'summary_generated_at',
                   'top', (select jsonb_agg(public.ed_public_prop(o)) from (
                             select o from jsonb_array_elements(case when jsonb_typeof(props -> 'top_opportunities') = 'array'
                                                                     then props -> 'top_opportunities' else '[]'::jsonb end) o limit 3) q)) end,
        'computed_at', computed_at,
        'sample', case when game_key = any(v_samples) then true end,
        'state_stale', computed_at < now() - interval '3 hours')) order by rn), '[]'::jsonb)
        from ranked where rn <= 8))
    into out;
  return out;
end $$;
revoke all on function public.public_home_board_build() from public, anon, authenticated;

-- THE anonymous door: the cached answer if it is under a minute old, else a
-- fresh one (one builder at a time; everyone else reads the last answer).
create or replace function public.public_home_board()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.public_home_board_cache%rowtype; v jsonb;
begin
  select * into c from public.public_home_board_cache where id = 1;
  if found and c.built_at > now() - interval '60 seconds' then
    return c.payload || jsonb_build_object('cached', true);
  end if;
  if not pg_try_advisory_xact_lock(hashtext('public_home_board')) then
    if found then return c.payload || jsonb_build_object('cached', true); end if;
  end if;
  v := public.public_home_board_build();
  insert into public.public_home_board_cache (id, payload, built_at) values (1, v, now())
  on conflict (id) do update set payload = excluded.payload, built_at = excluded.built_at;
  return v || jsonb_build_object('cached', false);
exception when others then
  raise warning 'public_home_board: %', sqlerrm;
  return jsonb_build_object('ok', false, 'reason', 'unavailable');
end $$;
revoke all on function public.public_home_board() from public;
grant execute on function public.public_home_board() to anon, authenticated;

create index if not exists game_research_state_kickoff on public.game_research_state (kickoff_at);

notify pgrst, 'reload schema';

-- ── report ───────────────────────────────────────────────────────────────────
select 1 as n, 'the landing page board is callable signed out' as check_name,
  case when has_function_privilege('anon', 'public.public_home_board()', 'execute') then 'ok' else 'CHECK THIS' end as outcome
union all
select 2, 'the builder, the cache and the helpers are not',
  case when not has_function_privilege('anon', 'public.public_home_board_build()', 'execute')
        and not has_function_privilege('anon', 'public.ed_public_prop(jsonb)', 'execute')
        and not has_table_privilege('anon', 'public.public_home_board_cache', 'select') then 'ok' else 'CHECK THIS' end
union all
select 3, 'the research state itself stays closed to signed-out visitors',
  case when not has_table_privilege('anon', 'public.game_research_state', 'select') then 'ok' else 'CHECK THIS' end
union all
select 4, 'the board answers (' || coalesce(jsonb_array_length(public.public_home_board_build() -> 'games'), 0)::text || ' upcoming game(s) on it now)',
  case when (public.public_home_board_build() ->> 'ok') = 'true' then 'ok' else 'CHECK THIS' end
order by 1;
