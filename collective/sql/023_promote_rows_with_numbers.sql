-- Corrected fix: 022 step 2 was a no-op on your data
--
-- 022 cleared the graded-candidate flag only from a row that had NO spread
-- AND NO market line. Your flagged rows carry a line (-3.5, +2.5, ...) but no
-- spread, so the condition never matched, the flag never moved, and step 4
-- returned the same empty row - now with line_at_submission and cover_prob
-- visible, because step 3's view change did work.
--
-- A row should lose the flag when it has no SPREAD, whatever else it carries.
-- That is the only change here. The guard is unchanged: a row loses the flag
-- only when another row for the same model and game actually has a spread, so
-- nothing can be left unflagged.
--
-- Run 022 first if you have not (its step 3 adds line_at_submission and
-- cover_prob to board_models, and that part worked). This supersedes its
-- step 2.

-- ---------------------------------------------------------------- STEP 1
-- Inventory. One line per game: how many rows are stored, how many carry a
-- spread, and what the currently flagged row holds.
--
-- READ has_spread FIRST. If it is 0 everywhere, this script cannot help:
-- the numbers never reached the database at all, and the problem is inside
-- ingest_submission rather than in which row is flagged. Paste this output
-- either way.

select c.slug                                                          as creator,
       gd.label                                                        as game,
       count(*)                                                        as stored_rows,
       count(*) filter (where p.projected_spread is not null)           as has_spread,
       count(*) filter (where p.is_graded_candidate)                    as flagged,
       max(p.projected_spread) filter (where p.is_graded_candidate)     as flagged_spread,
       max(p.line_at_submission) filter (where p.is_graded_candidate)   as flagged_line,
       max(p.projected_spread)                                          as best_spread_available
from collective.projections p
join collective.models   m  on m.id = p.model_id
join collective.creators c  on c.id = m.creator_id
left join collective.game_detail gd on gd.game_id = p.game_id
where p.data_origin = 'live'
group by c.slug, gd.label
order by c.slug, gd.label;

-- ---------------------------------------------------------------- STEP 2
-- Move the flag off rows with no spread, onto the earliest row that has one.
-- Not scoped to a creator: the guards make it safe for every model at once.
-- A model that has no spread on any row is untouched and keeps showing its
-- market line and cover probability.

update collective.projections p
set    is_graded_candidate = false
where  p.data_origin = 'live'
  and  p.is_graded_candidate
  and  p.projected_spread is null
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
-- After: exactly what the API serves and the wall renders.

select bm.creator_slug, gd.label as game, bm.pick_side,
       bm.projected_spread, bm.projected_total, bm.home_win_prob,
       bm.line_at_submission, bm.cover_prob
from collective.board_models bm
join collective.game_detail gd on gd.game_id = bm.game_id
order by bm.creator_slug, gd.label;

-- Both statements in step 2 are no-ops on a second run. Rollback is moving
-- the boolean back; nothing is deleted and no number is altered.
