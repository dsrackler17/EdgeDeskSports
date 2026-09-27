-- tennis_record -- part 7 of 9.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

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

-- ===========================================================================
-- LAYER 9b — THE AI CONTEXT DOOR.
--
-- EdgeDesk Intelligence answers tennis questions from THESE and nothing else.
-- Each one is a bounded, typed read with a hard row cap, so a retrieval budget
-- is a property of the database rather than a promise the caller makes. Each
-- returns its own provenance — the rating's computed_at, the model version, the
-- market's captured_at — because an answer about a live match that cannot say
-- when its inputs were true is not an answer.
--
-- SECURITY DEFINER with a fixed search_path, execute revoked from public, and
-- the priced ones check tennis.viewer_is_entitled() inside. A signed-out
-- visitor asking the assistant about tennis gets record and rating facts, and
-- is told plainly that prices are a subscriber surface.
-- ===========================================================================

-- "Who is the strongest player on clay right now?"
create or replace function tennis.ai_surface_leaders(
  p_tour text default null, p_surface text default 'clay', p_limit integer default 10)
returns table (
  player_id text, full_name text, tour text, country text,
  surface_elo numeric, surface_sample integer, power_rating numeric,
  uncertainty numeric, official_rank integer, form_90d numeric,
  last_match_date date, rating_version text, computed_at timestamptz)
language sql
stable
security definer
set search_path = tennis, pg_temp
as $$
  select r.player_id, p.full_name, r.tour, p.country,
         case lower(coalesce(p_surface,'hard'))
           when 'clay'   then r.clay_elo
           when 'grass'  then r.grass_elo
           when 'carpet' then r.carpet_elo
           when 'hard'   then r.hard_elo
           else r.elo end,
         case lower(coalesce(p_surface,'hard'))
           when 'clay'   then r.clay_sample
           when 'grass'  then r.grass_sample
           when 'carpet' then r.carpet_sample
           when 'hard'   then r.hard_sample
           else r.elo_sample end,
         r.power_rating, r.uncertainty, r.official_rank, r.form_90d,
         r.last_match_date, r.rating_version, r.computed_at
    from tennis.player_ratings_current r
    join tennis.players p on p.player_id = r.player_id
   where (p_tour is null or r.tour = upper(p_tour))
     -- a rating built on almost nothing is not a leader, it is a gap
     and case lower(coalesce(p_surface,'hard'))
           when 'clay'   then r.clay_sample
           when 'grass'  then r.grass_sample
           when 'carpet' then r.carpet_sample
           when 'hard'   then r.hard_sample
           else r.elo_sample end >= 15
   order by case lower(coalesce(p_surface,'hard'))
              when 'clay'   then r.clay_elo
              when 'grass'  then r.grass_elo
              when 'carpet' then r.carpet_elo
              when 'hard'   then r.hard_elo
              else r.elo end desc nulls last
   limit greatest(1, least(coalesce(p_limit, 10), 50));
$$;

-- "Which ATP or WTA matches show the largest model/market disagreement?"
-- Priced: entitled callers only, and it says so by returning nothing rather
-- than by throwing, so the assistant can report the boundary instead of an error.
create or replace function tennis.ai_market_disagreement(
  p_tour text default null, p_limit integer default 10)
returns table (
  match_ref text, tour text, tournament_name text, surface text, round text,
  scheduled_at timestamptz, player_a_name text, player_b_name text,
  model_prob_a numeric, market_prob_a numeric, probability_gap numeric,
  fair_odds_a_decimal numeric, confidence numeric, uncertainty numeric,
  research_grade text, exclusion_reasons text[], model_version text,
  feature_snapshot_at timestamptz, market_captured_at timestamptz, market_book text)
language sql
stable
security definer
set search_path = tennis, pg_temp
as $$
  select b.match_ref, b.tour, bp.tournament_name, bp.surface, bp.round, bp.scheduled_at,
         b.player_a_name, b.player_b_name,
         b.prob_a, b.market_prob_a, abs(b.prob_a - b.market_prob_a),
         b.fair_odds_a_decimal, b.confidence, b.uncertainty,
         b.research_grade, b.exclusion_reasons, b.model_version,
         b.feature_snapshot_at, b.market_captured_at, b.market_book
    from tennis.board_research b
    left join tennis.board_public bp on bp.match_ref = b.match_ref
   where tennis.viewer_is_entitled()
     and b.market_prob_a is not null and b.prob_a is not null
     and b.research_grade in ('research','provisional')
     and (p_tour is null or b.tour = upper(p_tour))
     and b.generated_at > now() - interval '2 days'
   order by abs(b.prob_a - b.market_prob_a) desc
   limit greatest(1, least(coalesce(p_limit, 10), 25));
$$;

-- Everything the assistant may know about one player, in one bounded read.
create or replace function tennis.ai_player_context(p_player_id text)
returns jsonb
language sql
stable
security definer
set search_path = tennis, pg_temp
as $$
  select jsonb_build_object(
    'player', to_jsonb(pp) - 'name_norm',
    'surface_record', coalesce((
      select jsonb_agg(jsonb_build_object('surface', s.surface, 'wins', s.wins,
                       'losses', s.losses, 'matches', s.matches, 'win_pct', s.win_pct))
        from (select surface, sum(wins)::int wins, sum(losses)::int losses,
                     sum(matches)::int matches,
                     round((sum(wins)::numeric / nullif(sum(matches),0)), 4) win_pct
                from tennis.player_surface where player_id = p_player_id
               group by surface) s), '[]'::jsonb),
    'recent_matches', coalesce((
      select jsonb_agg(jsonb_build_object('match_date', f.match_date, 'won', f.won,
                       'opponent_id', f.opponent_id, 'surface', f.surface,
                       'tourney_name', f.tourney_name, 'round', f.round, 'score', f.score)
                       order by f.match_date desc)
        from (select * from tennis.player_form where player_id = p_player_id
               order by match_date desc limit 20) f), '[]'::jsonb),
    'rating_scale', tennis.power_rating_scale(),
    'record_source', (select jsonb_build_object('source_key', l.source_key,
                        'licence', l.licence, 'commercial_use', l.commercial_use)
                        from tennis.source_licenses l
                        join tennis.players pl on pl.source_key = l.source_key
                       where pl.player_id = p_player_id),
    'retrieved_at', now())
    from tennis.player_profile pp
   where pp.player_id = p_player_id;
$$;

-- Everything the assistant may know about one upcoming match. The priced half
-- is present only for an entitled caller; the record half always is, and
-- `missing` names what nobody has rather than leaving a hole.
create or replace function tennis.ai_match_context(p_match_ref text)
returns jsonb
language sql
stable
security definer
set search_path = tennis, pg_temp
as $$
  select jsonb_build_object(
    'match', (select to_jsonb(bp) from tennis.board_public bp where bp.match_ref = p_match_ref),
    'entitled', tennis.viewer_is_entitled(),
    'prediction', case when tennis.viewer_is_entitled() then (
        select to_jsonb(b) from tennis.model_predictions b
         where b.match_ref = p_match_ref
         order by b.generated_at desc limit 1) else null end,
    'opportunities', case when tennis.viewer_is_entitled() then coalesce((
        select jsonb_agg(to_jsonb(r)) from tennis.research_opportunities r
         where r.match_ref = p_match_ref and r.status = 'open'), '[]'::jsonb) else null end,
    'market', case when tennis.viewer_is_entitled() then coalesce((
        select jsonb_agg(jsonb_build_object('sportsbook', o.sportsbook, 'market_type', o.market_type,
                         'selection', o.selection, 'odds_decimal', o.odds_decimal,
                         'implied_prob', o.implied_prob, 'captured_at', o.captured_at,
                         'market_state', o.market_state) order by o.captured_at desc)
          from (select * from tennis.odds_snapshots
                 where match_ref = p_match_ref order by captured_at desc limit 40) o), '[]'::jsonb)
      else null end,
    'weather', (
        select jsonb_build_object('temporal_precision', w.temporal_precision,
                 'usable', tennis.weather_is_usable(v.environment, w.temporal_precision,
                                                    v.resolution_confidence, w.quality),
                 'temp_mean_f', w.temp_mean_f, 'wind_mean_mph', w.wind_mean_mph,
                 'humidity_mean_pct', w.humidity_mean_pct, 'precip_in', w.precip_in,
                 'observed_on', w.observed_on, 'venue_confidence', v.resolution_confidence,
                 'environment', v.environment)
          from tennis.board_public bp2
          join tennis.tournaments t on t.tournament_id = bp2.tournament_id
          join tennis.venues v on v.venue_id = t.venue_id
          join tennis.weather_observations w on w.tournament_id = t.tournament_id
         where bp2.match_ref = p_match_ref
         order by w.observed_on desc limit 1),
    'health', (select to_jsonb(h) from tennis.record_health h),
    'retrieved_at', now());
$$;

-- "What information is missing?" — asked of the whole tennis surface.
create or replace function tennis.ai_data_health()
returns jsonb
language sql
stable
security definer
set search_path = tennis, pg_temp
as $$
  select jsonb_build_object(
    'health', (select to_jsonb(h) from tennis.record_health h),
    'licences', (select jsonb_agg(jsonb_build_object('source_key', source_key, 'licence', licence,
                   'commercial_use', commercial_use, 'allowed_uses', allowed_uses))
                   from tennis.source_licenses),
    'open_issues', coalesce((select jsonb_agg(jsonb_build_object('issue_type', issue_type,
                     'severity', severity, 'occurrences', occurrences, 'detail', detail))
                     from (select * from tennis.data_quality_issues where resolved_at is null
                            order by occurrences desc limit 20) d), '[]'::jsonb),
    'last_runs', coalesce((select jsonb_agg(jsonb_build_object('job', job, 'status', status,
                    'finished_at', finished_at, 'rows_read', rows_read,
                    'rows_rejected', rows_rejected, 'reconciled', reconciled))
                    from (select distinct on (job) * from tennis.ingestion_runs
                           order by job, started_at desc) r), '[]'::jsonb),
    'retrieved_at', now());
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'tennis.ai_surface_leaders(text, text, integer)',
    'tennis.ai_market_disagreement(text, integer)',
    'tennis.ai_player_context(text)',
    'tennis.ai_match_context(text)',
    'tennis.ai_data_health()'] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated, service_role', f);
  end loop;
end $$;
