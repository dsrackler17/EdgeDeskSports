-- tennis_record -- part 6 of 8.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- ===========================================================================
-- LAYER 9 — THE EXPOSED SURFACE. Narrow views, and nothing else.
--
-- Everything above is a base table with RLS on it. What the website reads is
-- these: a fixed projection of exactly the columns a screen needs, so a column
-- added to a base table later is not silently published, and so "never send
-- unused columns to the frontend" is a property of the contract rather than a
-- habit of the caller.
--
-- security_invoker = true on every one of them: the reader's own policies
-- decide what comes back, so a view can never be a way around a policy.
-- ===========================================================================

-- What ANYONE may see about an upcoming or live match: who is playing, where,
-- on what, and what EdgeDesk knows about the two players' records. No price,
-- no fair price, no edge, no EV. That is the paywall, drawn where every other
-- sport in this product draws it.
--
-- The fixtures come from the LIVE contract (tennis.live_matches), which may or
-- may not be installed yet — this file and tennis_live_center.sql are designed
-- to apply in either order. When it is absent the view is still created, with
-- the same column shape over no rows, so every caller downstream compiles and
-- reports "no fixtures" rather than "contract missing".
do $view$
begin
  if to_regclass('tennis.live_matches') is not null then
    execute $v$
      create or replace view tennis.board_public
      with (security_invoker = true) as
        select lm.match_id               as match_ref,
               'live'::text              as match_scope,
               lm.tour,
               lm.tournament_id,
               t.name                    as tournament_name,
               t.level                   as tournament_level,
               coalesce(t.surface, 'unknown') as surface,
               case when t.indoor is true then 'indoor'
                    when t.indoor is false then 'outdoor'
                    else coalesce(t.environment, 'unknown') end as environment,
               lm.round,
               lm.best_of,
               lm.scheduled_at,
               lm.status,
               lm.home_player_id         as player_a_id,
               lm.away_player_id         as player_b_id,
               lm.home_name              as player_a_name,
               lm.away_name              as player_b_name,
               ra.power_rating           as player_a_power,
               rb.power_rating           as player_b_power,
               ra.uncertainty            as player_a_uncertainty,
               rb.uncertainty            as player_b_uncertainty,
               ra.official_rank          as player_a_rank,
               rb.official_rank          as player_b_rank,
               ra.form_90d               as player_a_form_90d,
               rb.form_90d               as player_b_form_90d,
               ra.rest_days              as player_a_rest_days,
               rb.rest_days              as player_b_rest_days,
               ra.matches_14d            as player_a_matches_14d,
               rb.matches_14d            as player_b_matches_14d,
               greatest(coalesce(ra.computed_at, 'epoch'::timestamptz),
                        coalesce(rb.computed_at, 'epoch'::timestamptz)) as ratings_computed_at
          from tennis.live_matches lm
          left join tennis.tournaments t on t.tournament_id = lm.tournament_id
          left join tennis.player_ratings_current ra on ra.player_id = lm.home_player_id
          left join tennis.player_ratings_current rb on rb.player_id = lm.away_player_id
         where coalesce(lm.is_doubles, false) = false
    $v$;
  else
    execute $v$
      create or replace view tennis.board_public
      with (security_invoker = true) as
        select null::text as match_ref, 'live'::text as match_scope, null::text as tour,
               null::text as tournament_id, null::text as tournament_name,
               null::text as tournament_level, null::text as surface, null::text as environment,
               null::text as round, null::integer as best_of, null::timestamptz as scheduled_at,
               null::text as status, null::text as player_a_id, null::text as player_b_id,
               null::text as player_a_name, null::text as player_b_name,
               null::numeric as player_a_power, null::numeric as player_b_power,
               null::numeric as player_a_uncertainty, null::numeric as player_b_uncertainty,
               null::integer as player_a_rank, null::integer as player_b_rank,
               null::numeric as player_a_form_90d, null::numeric as player_b_form_90d,
               null::integer as player_a_rest_days, null::integer as player_b_rest_days,
               null::integer as player_a_matches_14d, null::integer as player_b_matches_14d,
               null::timestamptz as ratings_computed_at
         where false
    $v$;
  end if;
end $view$;

-- The research board itself. Every priced column lives here and nowhere else,
-- and the base tables underneath admit only an entitled reader — so an
-- unentitled caller reading this view gets zero rows from the database rather
-- than a redacted row from the application.
create or replace view tennis.board_research
with (security_invoker = true) as
  select p.prediction_id,
         p.match_scope,
         p.match_ref,
         p.tour,
         p.model_version,
         p.feature_version,
         p.generated_at,
         p.player_a_id, p.player_b_id, p.player_a_name, p.player_b_name,
         p.prob_a, p.prob_b,
         p.fair_odds_a_decimal, p.fair_odds_b_decimal,
         p.fair_odds_a_american, p.fair_odds_b_american,
         p.market_prob_a, p.market_prob_b,
         (p.prob_a - p.market_prob_a) as probability_gap_a,
         p.edge_a, p.edge_b, p.ev_a, p.ev_b,
         p.confidence, p.uncertainty,
         p.research_grade, p.exclusion_reasons, p.missing_inputs,
         p.feature_snapshot_at, p.market_snapshot_id,
         o.captured_at            as market_captured_at,
         o.sportsbook             as market_book,
         o.market_type            as market_type,
         o.market_state           as market_state
    from tennis.model_predictions p
    left join tennis.odds_snapshots o on o.snapshot_id = p.market_snapshot_id;

-- THE BOARD THE WEBSITE ACTUALLY READS: the LATEST prediction per match, with
-- the fixture beside it. Predictions are append-only, so a match accumulates a
-- row every time the board is rebuilt; the page wants the current one, and
-- PostgREST cannot express `distinct on`. So the contract does.
create or replace view tennis.board_current
with (security_invoker = true) as
  select distinct on (b.match_ref)
         b.prediction_id, b.match_scope, b.match_ref, b.tour, b.model_version, b.feature_version,
         b.generated_at, b.player_a_id, b.player_b_id, b.player_a_name, b.player_b_name,
         b.prob_a, b.prob_b, b.fair_odds_a_decimal, b.fair_odds_b_decimal,
         b.fair_odds_a_american, b.fair_odds_b_american,
         b.market_prob_a, b.market_prob_b, b.probability_gap_a,
         b.edge_a, b.edge_b, b.ev_a, b.ev_b, b.confidence, b.uncertainty,
         b.research_grade, b.exclusion_reasons, b.missing_inputs,
         b.feature_snapshot_at, b.market_captured_at, b.market_book, b.market_state,
         bp.tournament_name, bp.tournament_level, bp.surface, bp.environment, bp.round,
         bp.best_of, bp.scheduled_at, bp.status,
         bp.player_a_power, bp.player_b_power,
         bp.player_a_uncertainty, bp.player_b_uncertainty,
         bp.player_a_rank, bp.player_b_rank,
         bp.player_a_form_90d, bp.player_b_form_90d,
         bp.player_a_rest_days, bp.player_b_rest_days,
         bp.player_a_matches_14d, bp.player_b_matches_14d,
         bp.ratings_computed_at
    from tennis.board_research b
    join tennis.board_public bp on bp.match_ref = b.match_ref
   order by b.match_ref, b.generated_at desc;

-- Everything the match research page needs about one match, in one read.
create or replace view tennis.match_context
with (security_invoker = true) as
  select b.*,
         r.opportunity_id,
         r.market_type          as opportunity_market,
         r.selection            as opportunity_selection,
         r.sportsbook           as opportunity_book,
         r.estimated_edge,
         r.expected_value,
         r.data_quality_score,
         r.market_quality_score,
         r.reason_codes,
         r.status               as opportunity_status,
         r.expires_at           as opportunity_expires_at
    from tennis.board_research b
    left join tennis.research_opportunities r
           on r.match_scope = b.match_scope
          and r.match_ref = b.match_ref
          and r.prediction_id = b.prediction_id
          and r.status = 'open';

-- The public player profile. Indexable, anonymous, and every number on it is a
-- count over the stored record or a rating with its sample attached.
create or replace view tennis.player_profile
with (security_invoker = true) as
  select p.player_id,
         p.tour,
         p.full_name,
         p.name_norm,
         p.country,
         p.plays,
         p.height_cm,
         p.birth_date,
         p.latest_age,
         p.first_match,
         p.last_match,
         p.matches_on_file,
         p.active,
         r.power_rating,
         r.power_rating_surface,
         r.uncertainty,
         r.rating_sample,
         r.elo, r.hard_elo, r.clay_elo, r.grass_elo, r.carpet_elo,
         r.hard_sample, r.clay_sample, r.grass_sample, r.carpet_sample,
         r.form_30d, r.form_90d, r.form_365d, r.form_sample_365d,
         r.matches_7d, r.matches_14d, r.matches_28d, r.rest_days,
         r.days_since_last_match,
         r.rating_version,
         r.computed_at as rating_computed_at,
         k.rank as official_rank,
         k.points as official_rank_points,
         k.as_of as official_rank_as_of,
         c.wins, c.losses, c.matches, c.win_pct
    from tennis.players p
    left join tennis.player_ratings_current r on r.player_id = p.player_id
    left join tennis.rankings_current k on k.player_id = p.player_id
    left join tennis.player_career c on c.player_id = p.player_id;

-- THE OPERATIONAL NUMBERS, through a narrow door.
--
-- tennis.ingestion_runs and tennis.data_quality_issues are PRIVATE: they are the
-- pipeline's own diary and no browser reads them. But the board header has to be
-- able to say "the last ingest succeeded four hours ago" and "two data-quality
-- issues are open", or a reader cannot tell fresh from stale.
--
-- So exactly three AGGREGATE numbers come out, through a security-definer
-- function with a fixed search path. No row, no job name, no error text, no
-- entity id. A `security_invoker` view cannot do this — it would need the
-- caller to hold SELECT on the private tables, which is the thing being avoided.
--
-- This is also a bug this file previously had and did not notice: the earlier
-- record_health read those tables directly as an invoker view, which worked
-- only because `select count(*) from tennis.record_health` lets the planner skip
-- the scalar subqueries entirely. A reader doing `select *` — which is what the
-- page actually does — got "permission denied for table ingestion_runs".
create or replace function tennis.ops_health()
returns table (last_successful_ingest timestamptz, failed_runs_7d bigint,
               open_data_issues bigint, last_prediction_at timestamptz,
               open_opportunities bigint)
language sql
stable
security definer
set search_path = tennis, pg_temp
as $$
  select (select max(finished_at) from tennis.ingestion_runs where status = 'ok'),
         (select count(*) from tennis.ingestion_runs
           where status = 'error' and started_at > now() - interval '7 days'),
         (select count(*) from tennis.data_quality_issues where resolved_at is null),
         -- WHEN the last prediction was made and HOW MANY opportunities are open.
         -- Both are freshness facts: they say the system is alive. Neither says
         -- what the model thinks or what any price is, so both are safe for an
         -- anonymous header while the tables behind them stay subscriber-gated.
         (select max(generated_at) from tennis.model_predictions),
         (select count(*) from tennis.research_opportunities where status = 'open');
$$;
revoke all on function tennis.ops_health() from public;
grant execute on function tennis.ops_health() to anon, authenticated, service_role;

-- Data freshness and coverage, for the page header and for the AI's "what is
-- missing" answer. One row.
--
-- ONE PASS OVER tennis.matches, NOT FOUR. The obvious version asks for the row
-- count, the ATP count, the WTA count, the first date, the last date and the
-- unknown-surface count as six separate scalar subqueries — six sequential
-- scans of the same table. Measured against 290,280 matches that took 334 ms,
-- and this view is loaded on EVERY research-board render, so it was the slowest
-- thing a reader waited for. Folding them into one aggregate with FILTER
-- clauses does the same work in a single pass.
create or replace view tennis.record_health
with (security_invoker = true) as
  with m as (
    select count(*)                                              as matches,
           count(*) filter (where tour = 'ATP')                  as atp_matches,
           count(*) filter (where tour = 'WTA')                  as wta_matches,
           count(*) filter (where surface is null or surface = 'unknown') as matches_without_surface,
           min(match_date)                                       as first_match_date,
           max(match_date)                                       as last_match_date
      from tennis.matches
  ), r as (
    select count(*) as rated_players, max(computed_at) as ratings_computed_at
      from tennis.player_ratings_current
  ), i as (
    -- through the narrow definer door above, so the private tables stay private
    select * from tennis.ops_health()
  )
  select m.matches, m.atp_matches, m.wta_matches,
         (select count(*) from tennis.players)                   as players,
         m.first_match_date, m.last_match_date, m.matches_without_surface,
         r.rated_players, r.ratings_computed_at,
         (select model_version from tennis.model_registry
           where family = 'tennis_match_winner' and status = 'active')  as active_model_version,
         i.last_prediction_at, i.open_opportunities,
         i.last_successful_ingest, i.failed_runs_7d, i.open_data_issues,
         -- is EVERY source behind the stored record cleared for commercial use?
         -- Today this is false, deliberately, and the board says so on screen.
         (select bool_and(l.commercial_use) from tennis.source_licenses l
           where exists (select 1 from tennis.matches mm where mm.source_key = l.source_key))
                                                                 as record_cleared_for_commercial_use
    from m, r, i;
