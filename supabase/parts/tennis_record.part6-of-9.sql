-- tennis_record -- part 6 of 9.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- ===========================================================================
-- ENTITLEMENT. One authority, reused rather than re-implemented.
--
-- public.community_is_entitled(uuid) is the project's entitlement rule: the
-- owner comp, the active/trialing period, and Stripe's 21-day past_due grace.
-- This delegates to it wherever it is installed, so tennis can never drift
-- from what the rest of the product means by "subscriber". The fallback exists
-- only so this file applies to a database that has tennis but not yet the
-- community contract — and it evaluates the identical predicate against
-- public.subscriptions rather than inventing a second rule.
-- ===========================================================================
create or replace function tennis.viewer_is_entitled()
returns boolean
language plpgsql
stable
security definer
set search_path = public, tennis, pg_temp
as $$
declare
  uid uuid;
  ok  boolean;
begin
  begin
    uid := auth.uid();
  exception when others then
    return false;
  end;
  if uid is null then return false; end if;

  if to_regprocedure('public.community_is_entitled(uuid)') is not null then
    execute 'select public.community_is_entitled($1)' into ok using uid;
    return coalesce(ok, false);
  end if;

  if to_regclass('public.subscriptions') is null then return false; end if;
  execute $q$
    select exists (
      select 1 from public.subscriptions s
       where s.user_id = $1
         and ( (s.status = 'active' and coalesce(s.price_id, '') in ('owner_comp'))
            or (s.status in ('active','trialing')
                and (s.current_period_end is null or s.current_period_end >= now()))
            or (s.status = 'past_due'
                and (s.current_period_end is null or now() - s.current_period_end < interval '21 days')) )
    )
  $q$ into ok using uid;
  return coalesce(ok, false);
end $$;
revoke all on function tennis.viewer_is_entitled() from public;
grant execute on function tennis.viewer_is_entitled() to anon, authenticated, service_role;

-- ===========================================================================
-- PROVENANCE, RE-ATTACHED. Repairing a contract that was only half applied.
--
-- Every table above declares its link to tennis.ingestion_runs INLINE, in the
-- create table body. That is correct on a clean database and useless on a
-- half-built one: `create table if not exists` skips a table that already
-- exists, and skips its constraints with it. A database where the run ledger
-- was never created but the entity tables were — which is exactly what
-- happened here, a hand-paste of the eight split files in which part 1 and
-- part 5 did not land — gets its missing TABLES back from a re-apply and none
-- of its provenance. Eleven foreign keys, silently absent, on a schema whose
-- first premise is that no row is of unknown origin.
--
-- So the links are asserted again here, after every table exists, in the same
-- guarded form LAYER 2 already uses for tennis.tournaments. On a clean install
-- each one is already present and every branch is skipped. On a partial one
-- they are what makes a re-apply a REPAIR rather than a patch over a hole.
-- ===========================================================================
do $$
begin
  if to_regclass('tennis.data_quality_issues') is not null
     and not exists (select 1 from pg_constraint where conname = 'data_quality_issues_run_id_fkey') then
    alter table tennis.data_quality_issues add constraint data_quality_issues_run_id_fkey
      foreign key (run_id) references tennis.ingestion_runs (run_id) on delete set null;
  end if;
  if to_regclass('tennis.stg_archive_matches') is not null
     and not exists (select 1 from pg_constraint where conname = 'stg_archive_matches_run_id_fkey') then
    alter table tennis.stg_archive_matches add constraint stg_archive_matches_run_id_fkey
      foreign key (run_id) references tennis.ingestion_runs (run_id) on delete cascade;
  end if;
  if to_regclass('tennis.players') is not null
     and not exists (select 1 from pg_constraint where conname = 'players_ingestion_run_id_fkey') then
    alter table tennis.players add constraint players_ingestion_run_id_fkey
      foreign key (ingestion_run_id) references tennis.ingestion_runs (run_id) on delete set null;
  end if;
  if to_regclass('tennis.venues') is not null
     and not exists (select 1 from pg_constraint where conname = 'venues_ingestion_run_id_fkey') then
    alter table tennis.venues add constraint venues_ingestion_run_id_fkey
      foreign key (ingestion_run_id) references tennis.ingestion_runs (run_id) on delete set null;
  end if;
  if to_regclass('tennis.matches') is not null
     and not exists (select 1 from pg_constraint where conname = 'matches_ingestion_run_id_fkey') then
    alter table tennis.matches add constraint matches_ingestion_run_id_fkey
      foreign key (ingestion_run_id) references tennis.ingestion_runs (run_id) on delete set null;
  end if;
  if to_regclass('tennis.player_match_features') is not null
     and not exists (select 1 from pg_constraint where conname = 'player_match_features_ingestion_run_id_fkey') then
    alter table tennis.player_match_features add constraint player_match_features_ingestion_run_id_fkey
      foreign key (ingestion_run_id) references tennis.ingestion_runs (run_id) on delete set null;
  end if;
  if to_regclass('tennis.player_ratings_current') is not null
     and not exists (select 1 from pg_constraint where conname = 'player_ratings_current_ingestion_run_id_fkey') then
    alter table tennis.player_ratings_current add constraint player_ratings_current_ingestion_run_id_fkey
      foreign key (ingestion_run_id) references tennis.ingestion_runs (run_id) on delete set null;
  end if;
  if to_regclass('tennis.rankings_current') is not null
     and not exists (select 1 from pg_constraint where conname = 'rankings_current_ingestion_run_id_fkey') then
    alter table tennis.rankings_current add constraint rankings_current_ingestion_run_id_fkey
      foreign key (ingestion_run_id) references tennis.ingestion_runs (run_id) on delete set null;
  end if;
  if to_regclass('tennis.weather_observations') is not null
     and not exists (select 1 from pg_constraint where conname = 'weather_observations_ingestion_run_id_fkey') then
    alter table tennis.weather_observations add constraint weather_observations_ingestion_run_id_fkey
      foreign key (ingestion_run_id) references tennis.ingestion_runs (run_id) on delete set null;
  end if;
  if to_regclass('tennis.odds_snapshots') is not null
     and not exists (select 1 from pg_constraint where conname = 'odds_snapshots_ingestion_run_id_fkey') then
    alter table tennis.odds_snapshots add constraint odds_snapshots_ingestion_run_id_fkey
      foreign key (ingestion_run_id) references tennis.ingestion_runs (run_id) on delete set null;
  end if;
  if to_regclass('tennis.model_predictions') is not null
     and not exists (select 1 from pg_constraint where conname = 'model_predictions_ingestion_run_id_fkey') then
    alter table tennis.model_predictions add constraint model_predictions_ingestion_run_id_fkey
      foreign key (ingestion_run_id) references tennis.ingestion_runs (run_id) on delete set null;
  end if;
end $$;

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
