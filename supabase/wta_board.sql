-- ===========================================================================
-- EdgeDesk Tennis — the WTA RESEARCH BOARD contract.
--
-- WHY THIS FILE EXISTS. app.html has read `wta.daily_research`,
-- `wta.watchlist` and `wta.meta` since the Tennis panel shipped. The Slate,
-- Qualify and Watched counters on the overview are those three tables, the
-- research cards are built from their columns, and the panel's CLV line is
-- the only edge evidence on the screen.
--
-- No file in this repository has ever created them. Not renamed, not moved,
-- not deleted — `git log --all --name-only` matches no path containing "wta"
-- at any point in this repository's history. The schema is named in
-- supabase/expose_schemas.sql, so PostgREST routes to it and answers; what it
-- answers is that the relations are not there. That is why the panel reported
--
--     The wta schema answers and is empty — zero rows.
--
-- and why every counter read 0 while the Live Match Center, which reads
-- tennis.live_matches, worked perfectly.
--
-- THIS DOES NOT BUILD A SECOND PIPELINE. That was the tempting mistake. The
-- `tennis` contract already computes everything these three tables were meant
-- to carry — tennis.board_current alone is a superset of daily_research, and
-- tennis.prediction_record carries the graded CLV the watchlist reports. A
-- second producer would mean two models, two records and two answers to the
-- same question, which is how the module got into this state.
--
-- So all three are VIEWS over the tennis record. There is one pipeline, one
-- model registry and one published record; `wta` is the shape the page asks
-- for, over the data the repository already builds and tests.
--
-- WHAT THAT MEANS IN PRACTICE. These views come alive the moment the archive
-- is imported (docs/runbooks/tennis-import.md) and the nightly jobs run. They
-- need no separate build, no separate schedule and no separate backfill, and
-- they cannot drift from the record, because they ARE the record.
--
-- SECURITY. Every view is security_invoker = true, so the caller's own RLS
-- decides what they see — the same paywall that governs tennis.board_current
-- governs this, unchanged. Nothing here widens who may read what.
--
-- LICENSING. Each research row carries `commercial_ok`, which is
-- tennis.license_allows() asked about the training source of the model that
-- produced the row. The archive is CC BY-NC-SA: research yes, sale no. A row
-- with commercial_ok = false is honest research output that must not be sold.
-- See docs/runbooks/tennis-licensing.md.
--
-- NOTHING IS INVENTED. Every number below is arithmetic over a stored column.
-- Where a component cannot be computed from the record it is NULL and the
-- page renders nothing for it, rather than a zero that reads like a measured
-- result.
-- ===========================================================================

create schema if not exists wta;
grant usage on schema wta to anon, authenticated;

comment on schema wta is
  'The Tennis panel''s research board. Views over the tennis record contract; '
  'no tables, no separate pipeline. See supabase/wta_board.sql.';

-- ── A HAND-MADE wta SCHEMA GETS OUT OF THE WAY, IT DOES NOT GET DROPPED ────
-- The repository never created these three relations, but a PRODUCTION
-- database can still hold them: they were made by hand in the Supabase
-- dashboard before this file existed. `create or replace view` over a TABLE
-- does not replace it, it fails —
--
--     ERROR: 42809: "meta" is not a view
--
-- which is where this file stopped the first time it was run against the live
-- database, with wta.meta holding 14 rows.
--
-- Those rows are somebody's data. This RENAMES each pre-existing table aside
-- to <name>_legacy, keeping every row, and then builds the view in its place.
-- Nothing is dropped, so a wrong call here is reversible with a rename; and
-- because a second run finds a view rather than a table, it is idempotent.
-- Read what was preserved with:
--     select * from wta.meta_legacy;
do $$
declare r record; legacy text;
begin
  for r in
    select c.relname
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'wta'
       and c.relkind = 'r'                       -- an ordinary table, not a view
       and c.relname in ('meta', 'daily_research', 'watchlist')
  loop
    legacy := r.relname || '_legacy';
    -- never clobber an earlier rescue either
    if to_regclass('wta.' || legacy) is not null then
      legacy := legacy || '_' || to_char(now(), 'YYYYMMDDHH24MISS');
    end if;
    execute format('alter table wta.%I rename to %I', r.relname, legacy);
    raise notice 'wta.% was a TABLE and has been preserved as wta.% (% row(s)); the view now stands in its place',
      r.relname, legacy, (select n_live_tup from pg_stat_user_tables
                           where schemaname = 'wta' and relname = legacy);
  end loop;
end $$;

-- ── wta.meta ───────────────────────────────────────────────────────────────
-- The same key/value build stamps the rest of the app reads, plus the ranking
-- date the research cards print, so the page needs one call rather than two.
create or replace view wta.meta
with (security_invoker = true) as
  select key, value from tennis.meta
  union all
  select 'ranking_as_of',
         to_char(max(as_of), 'YYYY-MM-DD')
    from tennis.rankings_current
   where tour = 'WTA'
  having max(as_of) is not null;

-- ── wta.daily_research ─────────────────────────────────────────────────────
-- One row per upcoming match on the board, oriented favourite-first by the
-- MODEL's probability rather than by rank, because which player the model
-- prefers is the thing the card is about.
--
-- THE COMPONENT SCALES ARE THE CARD'S, and each is a bounded transform of one
-- stored quantity. The maxima (20/30/20/15/15, summing to 100) are the chip
-- widths app.html already draws; the constants that reach them are stated
-- here so nobody has to reverse them out of the arithmetic:
--
--   gap        20   rank distance, full at 200 places
--   dominance  30   power_rating difference (0-100 scale), full at 60 points
--   upset      20   the model preferring the LOWER-ranked player, same scale
--                   as gap; zero when the model agrees with the rankings
--   surface    15   surface win-rate difference this season, full at +1.000
--   form       15   90-day win-rate difference, full at +1.000
--
-- A component whose inputs are missing is NULL, not 0.
create or replace view wta.daily_research
with (security_invoker = true) as
with oriented as (
  select b.match_ref,
         b.scheduled_at,
         (b.scheduled_at at time zone 'UTC')::date          as slate_date,
         b.surface,
         b.tournament_name                                  as tourney_title,
         b.research_grade,
         b.exclusion_reasons,
         b.missing_inputs,
         b.model_version,
         b.confidence,
         greatest(b.prob_a, b.prob_b)                       as fav_prob,
         least(b.prob_a, b.prob_b)                          as dog_prob,
         case when b.prob_a >= b.prob_b then b.player_a_id   else b.player_b_id   end as fav_id,
         case when b.prob_a >= b.prob_b then b.player_b_id   else b.player_a_id   end as dog_id,
         case when b.prob_a >= b.prob_b then b.player_a_name else b.player_b_name end as fav_name,
         case when b.prob_a >= b.prob_b then b.player_b_name else b.player_a_name end as dog_name,
         case when b.prob_a >= b.prob_b then b.player_a_rank else b.player_b_rank end as fav_rank,
         case when b.prob_a >= b.prob_b then b.player_b_rank else b.player_a_rank end as dog_rank,
         case when b.prob_a >= b.prob_b then b.player_a_power else b.player_b_power end as fav_power,
         case when b.prob_a >= b.prob_b then b.player_b_power else b.player_a_power end as dog_power,
         case when b.prob_a >= b.prob_b then b.player_a_form_90d else b.player_b_form_90d end as fav_form,
         case when b.prob_a >= b.prob_b then b.player_b_form_90d else b.player_a_form_90d end as dog_form,
         case when b.prob_a >= b.prob_b then b.market_prob_a else b.market_prob_b end as fav_mkt,
         case when b.prob_a >= b.prob_b then b.market_prob_b else b.market_prob_a end as dog_mkt
    from tennis.board_current b
   where b.tour = 'WTA'
),
surfaced as (
  select o.*,
         fs.win_pct as fav_surface_pct,
         ds.win_pct as dog_surface_pct,
         fs.matches as fav_surface_n
    from oriented o
    left join tennis.player_surface fs
           on fs.player_id = o.fav_id and fs.surface = o.surface
          and fs.season = extract(year from o.slate_date)::int
    left join tennis.player_surface ds
           on ds.player_id = o.dog_id and ds.surface = o.surface
          and ds.season = extract(year from o.slate_date)::int
),
scored as (
  select s.*,
         /* each component, or NULL when its inputs are not on file */
         case when s.fav_rank is not null and s.dog_rank is not null
              then least(20.0, abs(s.dog_rank - s.fav_rank) * 0.10) end          as c_gap,
         case when s.fav_power is not null and s.dog_power is not null
              then least(30.0, greatest(0.0, s.fav_power - s.dog_power) * 0.50) end as c_dominance,
         case when s.fav_rank is not null and s.dog_rank is not null
              then case when s.fav_rank > s.dog_rank
                        then least(20.0, (s.fav_rank - s.dog_rank) * 0.10)
                        else 0.0 end end                                          as c_upset,
         case when s.fav_surface_pct is not null and s.dog_surface_pct is not null
              then greatest(0.0, (s.fav_surface_pct - s.dog_surface_pct)) * 15.0 end as c_surface,
         case when s.fav_form is not null and s.dog_form is not null
              then greatest(0.0, (s.fav_form - s.dog_form)) * 15.0 end            as c_form
    from surfaced s
),
totalled as (
  select sc.*,
         round(coalesce(sc.c_gap,0) + coalesce(sc.c_dominance,0) + coalesce(sc.c_upset,0)
             + coalesce(sc.c_surface,0) + coalesce(sc.c_form,0))::int            as research_score
    from scored sc
)
select t.match_ref,
       t.slate_date,
       t.fav_id, t.fav_name, t.fav_rank,
       t.dog_id, t.dog_name, t.dog_rank,
       case when t.fav_rank is not null and t.dog_rank is not null
            then abs(t.dog_rank - t.fav_rank) end                                as rank_gap,
       t.surface,
       t.tourney_title,
       t.research_score,
       /* THE GRADE IS A PRESENTATION BAND OVER THE SCORE, and nothing more.
          'hidden' is not a band: it is the pipeline's own exclusion, carried
          through unchanged so an excluded match stays visible as excluded
          rather than disappearing. */
       case when t.research_grade = 'excluded'
                 or cardinality(coalesce(t.exclusion_reasons, '{}')) > 0 then 'hidden'
            when t.research_score >= 70 then 'elite'
            when t.research_score >= 50 then 'strong'
            when t.research_score >= 30 then 'watch'
            else 'hidden' end                                                    as grade,
       jsonb_strip_nulls(jsonb_build_object(
         'gap',       round(t.c_gap, 1),
         'dominance', round(t.c_dominance, 1),
         'upset',     round(t.c_upset, 1),
         'surface',   round(t.c_surface, 1),
         'form',      round(t.c_form, 1)))                                       as components,
       /* Decimal prices from the captured market probability. The book's own
          number is not carried on the board view; this is its reciprocal, to
          two places, and is labelled a price because that is what it is. */
       case when t.fav_mkt > 0 then round(1.0 / t.fav_mkt, 2) end                as fav_dec,
       case when t.dog_mkt > 0 then round(1.0 / t.dog_mkt, 2) end                as dog_dec,
       case when t.fav_mkt > 0 then round(1.0 / t.fav_mkt, 2) end                as fav_price,
       case when t.dog_mkt > 0 then round(1.0 / t.dog_mkt, 2) end                as dog_price,
       (select to_char(max(rc.as_of), 'YYYY-MM-DD')
          from tennis.rankings_current rc where rc.tour = 'WTA')                 as ranking_as_of,
       /* Statements, each one a sentence about a number above it. Nothing is
          asserted here that is not already in this row. */
       (select array_remove(array[
          case when t.fav_rank is not null and t.dog_rank is not null
               then '#' || t.fav_rank || ' vs #' || t.dog_rank
                    || ' — ' || abs(t.dog_rank - t.fav_rank) || ' places apart' end,
          case when t.fav_prob is not null
               then 'The model gives ' || t.fav_name || ' '
                    || round(t.fav_prob * 100) || '%' end,
          case when t.fav_surface_pct is not null and t.fav_surface_n is not null
               then t.fav_name || ' has won ' || round(t.fav_surface_pct * 100)
                    || '% on ' || t.surface || ' this season (' || t.fav_surface_n || ' matches)' end,
          case when t.fav_form is not null
               then 'Form over 90 days: ' || round(t.fav_form * 100) || '%'
                    || case when t.dog_form is not null
                            then ' against ' || round(t.dog_form * 100) || '%' else '' end end,
          case when t.fav_rank is not null and t.dog_rank is not null and t.fav_rank > t.dog_rank
               then 'The model prefers the lower-ranked player' end
        ], null))                                                                as summary,
       /* Every reason the pipeline itself published, as chips. Not reworded. */
       /* THE CHIPS UNDER THE CARD. Every reason the pipeline itself published,
          not reworded — plus, when a row is held back purely for scoring under
          the qualifying floor, a chip that says exactly that. Without it the
          page renders "Excluded" with no reason, which reads as a judgement the
          pipeline never made. The panel's own standard is that every excluded
          count is accountable; this is what makes it so. */
       (select coalesce(jsonb_agg(jsonb_build_object('label', x)), '[]'::jsonb)
          from unnest(
                 coalesce(t.exclusion_reasons, '{}') || coalesce(t.missing_inputs, '{}')
                 || case when t.research_grade <> 'excluded'
                          and cardinality(coalesce(t.exclusion_reasons, '{}')) = 0
                          and t.research_score < 30
                         then array['research score ' || t.research_score
                                    || ', below the qualifying floor of 30']
                         else '{}'::text[] end) as x)
                                                                                 as disqualifiers,
       /* Favourite's recent match quality, parsed from the stored scorelines.
          NULL when there are none on file, so the line does not render. */
       (select case when count(*) = 0 then null else jsonb_build_object(
                 'window',        'last 20',
                 'matches',       count(*),
                 'ret_pct',       round(100.0 * count(*) filter (where f.score ~* '(RET|W/O|DEF)') / count(*)),
                 'tb_pct',        round(100.0 * count(*) filter (where f.score ~ '7-6|6-7') / count(*)),
                 'three_set_pct', round(100.0 * count(*) filter (
                                     where array_length(regexp_split_to_array(trim(f.score), '\s+'), 1) >= 3) / count(*))
               ) end
          from (select pf.score from tennis.player_form pf
                 where pf.player_id = t.fav_id and pf.score is not null
                 order by pf.match_date desc limit 20) f)                        as rates,
       /* WHETHER THIS ROW MAY BE SOLD. The model's training source decides,
          not the row. See tennis.enforce_commercial_clearance, which refuses
          the same claim on the write path. */
       coalesce((select tennis.license_allows(mr.source_key, 'commercial')
                   from tennis.model_registry mr
                  where mr.model_version = t.model_version), false)              as commercial_ok,
       t.model_version,
       t.confidence
  from totalled t;

comment on view wta.daily_research is
  'The Tennis panel''s research slate: tennis.board_current oriented '
  'favourite-first with the card''s five components computed from stored '
  'columns. No separate pipeline — this IS the record.';

-- ── wta.watchlist ──────────────────────────────────────────────────────────
-- Players the record keeps returning to, with their GRADED closing-line
-- arithmetic. Every column is an aggregate over tennis.prediction_record,
-- which is immutable and published before the match starts — which is the
-- only reason the CLV here means anything.
create or replace view wta.watchlist
with (security_invoker = true) as
with sides as (
  /* one row per (player, prediction), so a player is counted once per match
     whichever side of it they were on */
  select pr.player_a_id as player_id, pr.player_a_name as full_name,
         pr.surface, pr.scheduled_at, pr.research_grade, pr.clv, pr.beat_close
    from tennis.prediction_record pr where pr.tour = 'WTA'
  union all
  select pr.player_b_id, pr.player_b_name,
         pr.surface, pr.scheduled_at, pr.research_grade,
         /* CLV is stored from side A's perspective; side B's is its mirror */
         case when pr.clv is not null then -pr.clv end,
         case when pr.beat_close is not null then not pr.beat_close end
    from tennis.prediction_record pr where pr.tour = 'WTA'
),
agg as (
  select s.player_id,
         max(s.full_name)                                          as full_name,
         count(distinct (s.scheduled_at at time zone 'UTC')::date)  as appearances,
         count(*) filter (where s.clv is not null)                  as clv_events,
         avg(s.clv) filter (where s.clv is not null)                as clv_avg,
         avg(case when s.beat_close then 1.0 else 0.0 end)
           filter (where s.beat_close is not null)                  as beat_close_rate,
         /* RELIABILITY IS RESEARCH ATTENTION, NOT PROFIT — the share of this
            player's published predictions the pipeline graded fit to research
            rather than excluding. The card says so in as many words. */
         avg(case when s.research_grade = 'research' then 1.0 else 0.0 end) as reliability
    from sides s
   group by s.player_id
  having count(*) > 0
),
edges as (
  select s.player_id, s.surface, avg(s.clv) as edge
    from sides s where s.clv is not null and s.surface is not null
   group by s.player_id, s.surface
)
select a.player_id,
       a.full_name,
       rc.rank,
       a.appearances,
       a.clv_events,
       round(a.clv_avg, 5)                                          as clv_avg,
       round(a.beat_close_rate, 4)                                  as beat_close_rate,
       round(a.reliability, 4)                                      as reliability,
       coalesce((select jsonb_object_agg(e.surface, round(e.edge, 4))
                   from edges e where e.player_id = a.player_id), '{}'::jsonb) as surface_edge
  from agg a
  left join tennis.rankings_current rc
         on rc.player_id = a.player_id and rc.tour = 'WTA';

comment on view wta.watchlist is
  'Per-player graded closing-line arithmetic over tennis.prediction_record. '
  'Reliability is research attention, not profit.';

grant select on wta.meta, wta.daily_research, wta.watchlist to anon, authenticated;

-- PostgREST caches the schema it serves. Without this the three views are
-- built correctly and still not served, and the panel keeps reporting the
-- schema empty after a successful apply — a fix that looks like it failed.
notify pgrst, 'reload schema';

-- ── report ─────────────────────────────────────────────────────────────────
select 'wta.' || table_name as relation,
       case when to_regclass('wta.' || table_name) is not null then 'ok' else 'MISSING' end as status
  from (values ('meta'), ('daily_research'), ('watchlist')) as t(table_name);
