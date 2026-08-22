-- Make the uploaded numbers appear on the wall
--
-- Written against the real schema (readout of 2026-08-22), not assumptions.
-- Two separate faults, both outside the uploader:
--
-- 1. board_models serves a row only when is_graded_candidate is true (or the
--    row is late):
--
--      WHERE p.resolution_status = 'resolved' AND p.data_origin = 'live'
--        AND (p.is_graded_candidate OR p.is_late)
--
--    That flag is set at ingest on a model's first pre-kickoff submission per
--    game. The first submission for these games was made before the column
--    mapping was fixed and carries no spread, no total and no probability.
--    Every later upload is stored with is_graded_candidate = false, so the
--    view never returns it. The wall renders the one row it gets: "TEAM -".
--
--    Note there is no DISTINCT ON in that view. Deleting the empty row does
--    NOT promote a later one - it would leave nothing flagged and the game
--    would disappear from the wall entirely. The flag has to move.
--
-- 2. board_models does not select line_at_submission or cover_prob, but
--    collective_public/buildGames reads m.line_at_submission and m.cover_prob
--    and maps them into the response. They arrive undefined, so the wall's
--    market-line fallback and its cover-probability display can never render
--    for any model, whatever it submits.
--
-- STEP 1 changes nothing. Steps 2 and 3 are the fix.
--
-- WHAT STEP 2 CHANGES ABOUT GRADING: rule 4 grades a model's first
-- pre-kickoff submission. This moves that designation to the earliest
-- submission that actually carries a projection. The original carried none,
-- so grading it would have produced no margin error and no Brier at all.
-- Nothing is deleted and no number is altered. No Week 1 game has kicked off,
-- so nothing has been graded yet either way.

-- ---------------------------------------------------------------- STEP 1
-- Before. One row per stored submission, with the flag that decides which one
-- the wall sees.

select gd.label                as game,
       p.received_at,
       p.is_graded_candidate   as shown_on_wall,
       p.resolution_status,
       p.projected_spread,
       p.projected_total,
       p.home_win_prob,
       p.line_at_submission
from collective.projections p
join collective.models   m  on m.id = p.model_id
join collective.creators c  on c.id = m.creator_id
left join collective.game_detail gd on gd.game_id = p.game_id
where c.slug = 'edgedesk'          -- change the slug for another model
  and p.data_origin = 'live'
order by gd.label, p.received_at;

-- ---------------------------------------------------------------- STEP 2
-- Move the flag. An empty row loses it only when a row for the same model and
-- game actually carries a spread, so a game can never end up with nothing
-- flagged. Then the earliest such row takes its place. Both statements are
-- no-ops on a second run.

update collective.projections p
set    is_graded_candidate = false
where  p.data_origin = 'live'
  and  p.is_graded_candidate
  and  p.projected_spread is null
  and  p.line_at_submission is null
  and  exists (
         select 1 from collective.projections q
         where q.model_id = p.model_id and q.game_id = p.game_id
           and q.data_origin = 'live'
           and q.resolution_status = 'resolved'
           and q.projected_spread is not null
           and not q.is_late);

with best as (
  select distinct on (q.model_id, q.game_id) q.id
  from   collective.projections q
  where  q.data_origin = 'live'
    and  q.resolution_status = 'resolved'
    and  q.projected_spread is not null
    and  not q.is_late
    and  not exists (
           select 1 from collective.projections r
           where r.model_id = q.model_id and r.game_id = q.game_id
             and r.is_graded_candidate)
  order by q.model_id, q.game_id, q.received_at asc
)
update collective.projections p
set    is_graded_candidate = true
from   best
where  p.id = best.id;

-- ---------------------------------------------------------------- STEP 3
-- Give the view the two columns the API already reads. This is the definition
-- exactly as deployed, with line_at_submission and cover_prob appended, so
-- every existing column keeps its name and position.

create or replace view collective.board_models as
 SELECT p.game_id,
    p.model_id,
    c.slug AS creator_slug,
    m.slug AS model_slug,
    p.pick_side,
    p.projected_spread,
    p.projected_total,
    p.home_win_prob,
    p.received_at,
    p.is_late,
    gr.pick_result,
    gr.margin_error,
    gr.brier,
    p.line_at_submission,
    p.cover_prob
   FROM collective.projections p
     JOIN collective.models m ON m.id = p.model_id AND m.is_listed
     JOIN collective.creators c ON c.id = m.creator_id AND c.is_listed AND c.status = 'active'::collective.creator_status
     LEFT JOIN collective.grades gr ON gr.projection_id = p.id
  WHERE p.resolution_status = 'resolved'::collective.resolution_status
    AND p.data_origin = 'live'::collective.data_origin
    AND (p.is_graded_candidate OR p.is_late);

-- ---------------------------------------------------------------- STEP 4
-- After. This is exactly what the API now serves and the wall now renders.

select bm.creator_slug, gd.label as game, bm.pick_side,
       bm.projected_spread, bm.projected_total, bm.home_win_prob,
       bm.line_at_submission, bm.cover_prob
from collective.board_models bm
join collective.game_detail gd on gd.game_id = bm.game_id
order by bm.creator_slug, gd.label;

-- Rollback: step 2 only moved a boolean, so it reverses by moving it back;
-- step 3 reverses by recreating the view without the last two columns.
-- To fix another creator's model, change the slug in step 1 and rerun step 2
-- (step 2 is not slug-scoped: its guards make it safe for every model at once).
