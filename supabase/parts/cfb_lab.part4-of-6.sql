-- cfb_lab -- part 4 of 6.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- ======================================================= openers and closes
-- cfb_lab_open_v1 / cfb_lab_close_v1 (METRICS.md §4). For every game whose
-- kickoff + 3 h <= p_now (p_now may not be in the future) and that has no
-- CONSENSUS spread CLOSE yet, derive in one transaction, per market type
-- (spread always; total and moneyline when the game has any quote of that
-- type), over cfb_lab_game_quotes (the game's quotes, including those written
-- before their provider event was mapped). A "book" here is a (source, book) pair, written 'source:book'
-- (e.g. 'odds_api:draftkings'), so each provider's view of a book is its own
-- row and its own line_id. An ordinary pregame quote is is_pregame, neither
-- provider flag, and observed_at < kickoff.
--   per-book OPEN   the book's earliest ordinary pregame quote;
--   per-book CLOSE  the book's latest one in [kickoff - 180 min, kickoff);
--                   (ties: quote_id ascending; per-book n_books = 1)
--   CONSENSUS OPEN  t0 = earliest per-book opener; the band is the books whose
--                   opener is <= t0 + 24 h; provider averages (raw book
--                   'consensus', any case) are dropped when a real book is in
--                   the band; medians of the rest; observed_at = earliest
--                   used opener;
--   CONSENSUS CLOSE medians of the per-book closes, provider averages dropped
--                   when a real book closed; observed_at = latest used quote;
--   spread CONSENSUS (OPEN and CLOSE, OBSERVED or PROVIDER_DECLARED):
--                   best_line_home = max(home_line), best_line_away =
--                   -min(home_line) over the books used;
--   fallback        nothing observed -> the provider-declared rows
--                   (is_provider_open for OPEN, is_provider_close for CLOSE),
--                   each book's LATEST, same provider-average rule, quality
--                   PROVIDER_DECLARED, observed_at NULL (a declared number has
--                   no observation time of its own); none -> MISSING (values
--                   NULL, n_books 0, quote_ids {}).
-- Values per market: spread -> home_line, price_home, price_away; total ->
-- total_points, price_home = the OVER price, price_away = the UNDER price;
-- moneyline -> price_home, price_away. Medians: cfb_lab_median (lines, even
-- count = mean of the middle two) and cfb_lab_median_price (decimal-odds
-- space, 0 and NULL ignored). Lines are stored at 2 decimals. quote_ids are
-- the quotes used, sorted ascending. kickoff_ts is the game's kickoff
-- (cfb_lab_game_kickoff).
-- line_id = 'cfbl_' + h(game_id, kind, book, market_type, rule_version).
create or replace function public.cfb_lab_derive_lines(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  c_open    constant text := 'cfb_lab_open_v1';
  c_close   constant text := 'cfb_lab_close_v1';
  v_now     timestamptz := now();
  g         record;
  m         text;
  k         timestamptz;
  v_n       int;
  v_rows    int := 0;
  v_games   int := 0;
  v_obs     int := 0;
  v_decl    int := 0;
  v_missing int := 0;
  r         record;
begin
  if p_now is null or p_now > v_now + interval '1 minute' then
    raise exception 'cfb_lab_derive_lines: p_now % is in the future; a close is derived only after the fact', p_now
      using errcode = 'invalid_parameter_value';
  end if;
  perform pg_advisory_xact_lock(hashtext('cfb_lab_derive_lines'));

  for g in
    select u.game_id, public.cfb_lab_game_kickoff(u.game_id) as kickoff
      from (select q.game_id from public.cfb_lab_market_quotes q where q.game_id is not null
            union
            select p.game_id from public.cfb_lab_predictions p where p.origin = 'LIVE'
            union
            select cur.game_id
              from (select distinct on (m.source, m.provider_event_id) m.source, m.provider_event_id, m.game_id
                      from public.cfb_lab_event_map m
                     order by m.source, m.provider_event_id, m.created_at desc, m.recorded_at desc, m.map_id desc) cur
             where exists (select 1 from public.cfb_lab_market_quotes q
                            where q.game_id is null and q.source = cur.source and q.provider_event_id = cur.provider_event_id)) u
     where not exists (select 1 from public.cfb_lab_market_lines l
                        where l.game_id = u.game_id and l.kind = 'CLOSE'
                          and l.book = 'CONSENSUS' and l.market_type = 'spread')
     order by u.game_id
  loop
    k := g.kickoff;
    continue when k is null or k + interval '3 hours' > least(p_now, v_now);
    v_games := v_games + 1;

    foreach m in array array['spread','total','moneyline'] loop
      continue when m <> 'spread' and not exists (select 1 from public.cfb_lab_game_quotes(g.game_id) x where x.market_type = m);

      -- ------------------------------------------------ per-book OPEN and CLOSE
      insert into public.cfb_lab_market_lines (line_id, game_id, kind, book, market_type, home_line, total_points,
             price_home, price_away, observed_at, n_books, quality, best_line_home, best_line_away,
             rule_version, quote_ids, derived_at, kickoff_ts)
      select 'cfbl_' || public.cfb_lab_h(g.game_id, b.kind, b.source || ':' || b.book, m, b.rule), g.game_id, b.kind,
             b.source || ':' || b.book, m,
             case when m = 'spread' then b.home_line end,
             case when m = 'total' then b.total_points end,
             case when m = 'total' then b.price_over else b.price_home end,
             case when m = 'total' then b.price_under else b.price_away end,
             b.observed_at, 1, 'OBSERVED', null, null, b.rule, array[b.quote_id], v_now, k
        from (
          select * from (
            select distinct on (x.source, x.book) 'OPEN'::text as kind, c_open as rule, x.*
              from public.cfb_lab_game_quotes(g.game_id) x
             where x.market_type = m and x.is_pregame and not x.is_provider_open and not x.is_provider_close
               and x.observed_at < k
             order by x.source, x.book, x.observed_at asc, x.quote_id asc) o
          union all
          select * from (
            select distinct on (x.source, x.book) 'CLOSE'::text as kind, c_close as rule, x.*
              from public.cfb_lab_game_quotes(g.game_id) x
             where x.market_type = m and x.is_pregame and not x.is_provider_open and not x.is_provider_close
               and x.observed_at >= k - interval '180 minutes' and x.observed_at < k
             order by x.source, x.book, x.observed_at desc, x.quote_id asc) c
        ) b
      on conflict do nothing;
      get diagnostics v_n = row_count;
      v_rows := v_rows + v_n;

      -- ------------------------------------------------------ CONSENSUS OPEN
      with o as (
        select distinct on (x.source, x.book) x.*
          from public.cfb_lab_game_quotes(g.game_id) x
         where x.market_type = m and x.is_pregame and not x.is_provider_open and not x.is_provider_close
           and x.observed_at < k
         order by x.source, x.book, x.observed_at asc, x.quote_id asc
      ), band as (
        select o.* from o where o.observed_at <= (select min(o2.observed_at) from o o2) + interval '24 hours'
      ), used as (
        select * from band b
         where lower(b.book) <> 'consensus' or not exists (select 1 from band r2 where lower(r2.book) <> 'consensus')
      )
      select count(*) as n, public.cfb_lab_median(array_agg(home_line)) as home_line,
             public.cfb_lab_median(array_agg(total_points)) as total_points,
             public.cfb_lab_median_price(array_agg(case when m = 'total' then price_over else price_home end)) as price_home,
             public.cfb_lab_median_price(array_agg(case when m = 'total' then price_under else price_away end)) as price_away,
             min(observed_at) as observed_at, array_agg(quote_id order by quote_id) as quote_ids,
             max(home_line) as best_home, -min(home_line) as best_away,
             'OBSERVED'::text as quality
        into r from used;
      if r.n = 0 then
        with o as (
          select distinct on (x.source, x.book) x.*
            from public.cfb_lab_game_quotes(g.game_id) x
           where x.market_type = m and x.is_provider_open
           order by x.source, x.book, x.observed_at desc, x.quote_id asc
        ), used as (
          select * from o
           where lower(o.book) <> 'consensus' or not exists (select 1 from o r2 where lower(r2.book) <> 'consensus')
        )
        select count(*) as n, public.cfb_lab_median(array_agg(home_line)) as home_line,
               public.cfb_lab_median(array_agg(total_points)) as total_points,
               public.cfb_lab_median_price(array_agg(case when m = 'total' then price_over else price_home end)) as price_home,
               public.cfb_lab_median_price(array_agg(case when m = 'total' then price_under else price_away end)) as price_away,
               null::timestamptz as observed_at, array_agg(quote_id order by quote_id) as quote_ids,
               max(home_line) as best_home, -min(home_line) as best_away,
               'PROVIDER_DECLARED'::text as quality
          into r from used;
      end if;
      insert into public.cfb_lab_market_lines (line_id, game_id, kind, book, market_type, home_line, total_points,
             price_home, price_away, observed_at, n_books, quality, best_line_home, best_line_away,
             rule_version, quote_ids, derived_at, kickoff_ts)
      values ('cfbl_' || public.cfb_lab_h(g.game_id, 'OPEN', 'CONSENSUS', m, c_open), g.game_id, 'OPEN', 'CONSENSUS', m,
              case when r.n > 0 and m = 'spread' then r.home_line end,
              case when r.n > 0 and m = 'total' then r.total_points end,
              case when r.n > 0 then r.price_home end,
              case when r.n > 0 then r.price_away end,
              case when r.n > 0 then r.observed_at end, r.n,
              case when r.n > 0 then r.quality else 'MISSING' end,
              case when r.n > 0 and m = 'spread' then r.best_home end,
              case when r.n > 0 and m = 'spread' then r.best_away end,
              c_open, coalesce(case when r.n > 0 then r.quote_ids end, '{}'::text[]), v_now, k)
      on conflict do nothing;
      get diagnostics v_n = row_count;
      v_rows := v_rows + v_n;
      if v_n > 0 then
        if r.n = 0 then v_missing := v_missing + 1;
        elsif r.quality = 'OBSERVED' then v_obs := v_obs + 1;
        else v_decl := v_decl + 1; end if;
      end if;

      -- ----------------------------------------------------- CONSENSUS CLOSE
      with c as (
        select distinct on (x.source, x.book) x.*
          from public.cfb_lab_game_quotes(g.game_id) x
         where x.market_type = m and x.is_pregame and not x.is_provider_open and not x.is_provider_close
           and x.observed_at >= k - interval '180 minutes' and x.observed_at < k
         order by x.source, x.book, x.observed_at desc, x.quote_id asc
      ), used as (
        select * from c
         where lower(c.book) <> 'consensus' or not exists (select 1 from c r2 where lower(r2.book) <> 'consensus')
      )
      select count(*) as n, public.cfb_lab_median(array_agg(home_line)) as home_line,
             public.cfb_lab_median(array_agg(total_points)) as total_points,
             public.cfb_lab_median_price(array_agg(case when m = 'total' then price_over else price_home end)) as price_home,
             public.cfb_lab_median_price(array_agg(case when m = 'total' then price_under else price_away end)) as price_away,
             max(observed_at) as observed_at, array_agg(quote_id order by quote_id) as quote_ids,
             max(home_line) as best_home, -min(home_line) as best_away,
             'OBSERVED'::text as quality
        into r from used;
      if r.n = 0 then
        with c as (
          select distinct on (x.source, x.book) x.*
            from public.cfb_lab_game_quotes(g.game_id) x
           where x.market_type = m and x.is_provider_close
           order by x.source, x.book, x.observed_at desc, x.quote_id asc
        ), used as (
          select * from c
           where lower(c.book) <> 'consensus' or not exists (select 1 from c r2 where lower(r2.book) <> 'consensus')
        )
        select count(*) as n, public.cfb_lab_median(array_agg(home_line)) as home_line,
               public.cfb_lab_median(array_agg(total_points)) as total_points,
               public.cfb_lab_median_price(array_agg(case when m = 'total' then price_over else price_home end)) as price_home,
               public.cfb_lab_median_price(array_agg(case when m = 'total' then price_under else price_away end)) as price_away,
               null::timestamptz as observed_at, array_agg(quote_id order by quote_id) as quote_ids,
               max(home_line) as best_home, -min(home_line) as best_away,
               'PROVIDER_DECLARED'::text as quality
          into r from used;
      end if;
      insert into public.cfb_lab_market_lines (line_id, game_id, kind, book, market_type, home_line, total_points,
             price_home, price_away, observed_at, n_books, quality, best_line_home, best_line_away,
             rule_version, quote_ids, derived_at, kickoff_ts)
      values ('cfbl_' || public.cfb_lab_h(g.game_id, 'CLOSE', 'CONSENSUS', m, c_close), g.game_id, 'CLOSE', 'CONSENSUS', m,
              case when r.n > 0 and m = 'spread' then r.home_line end,
              case when r.n > 0 and m = 'total' then r.total_points end,
              case when r.n > 0 then r.price_home end,
              case when r.n > 0 then r.price_away end,
              case when r.n > 0 then r.observed_at end, r.n,
              case when r.n > 0 then r.quality else 'MISSING' end,
              case when r.n > 0 and m = 'spread' then r.best_home end,
              case when r.n > 0 and m = 'spread' then r.best_away end,
              c_close, coalesce(case when r.n > 0 then r.quote_ids end, '{}'::text[]), v_now, k)
      on conflict do nothing;
      get diagnostics v_n = row_count;
      v_rows := v_rows + v_n;
      if v_n > 0 then
        if r.n = 0 then v_missing := v_missing + 1;
        elsif r.quality = 'OBSERVED' then v_obs := v_obs + 1;
        else v_decl := v_decl + 1; end if;
      end if;
    end loop;
  end loop;

  return jsonb_build_object('games', v_games, 'rows_written', v_rows,
    'consensus_observed', v_obs, 'consensus_provider_declared', v_decl, 'consensus_missing', v_missing,
    'rule_versions', jsonb_build_object('open', c_open, 'close', c_close), 'p_now', p_now);
end $fn$;
