create or replace view public.audit_atp_daily_research
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
   where b.tour = 'ATP'
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
          from tennis.rankings_current rc where rc.tour = 'ATP')                 as ranking_as_of,
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
