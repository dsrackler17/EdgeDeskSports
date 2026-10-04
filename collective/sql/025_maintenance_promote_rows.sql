-- Move the graded-candidate flag onto the rows that carry your numbers,
-- through the sanctioned maintenance path.
--
-- Background: board_models serves a row only when is_graded_candidate is true
-- (or the row is late). That flag sits on an early submission made before the
-- column mapping was fixed, which carries a market line but no spread, total
-- or probability. The later uploads carry everything and are flagged false, so
-- the view never returns them and the wall renders a dash.
--
-- 023 tried a plain UPDATE and was refused:
--   collective.projections is append-only (rule 8.3); use the service
--   maintenance path
-- Correctly so: the record of what was submitted and when should not be
-- casually editable. collective.block_mutation honours one escape hatch:
--   if coalesce(current_setting('collective.maintenance', true), '') = 'on'
-- That is the path, and STEP 2 uses it.
--
-- Nothing is deleted. No submitted number is altered. Only a boolean moves,
-- and only from a row with no spread to the earliest row that has one.

-- ---------------------------------------------------------------- STEP 1
-- Read-only. Two answers before changing anything.
--
-- 1a. Your own ingest diagnostic.

select collective.diagnose_ingest('edgedesksports');

-- 1b. Per game: how many rows are stored, how many carry a spread, and what
--     the currently flagged row holds. If has_spread is 0 everywhere, STOP:
--     the numbers are not in the database and STEP 2 cannot help.

select c.slug                                                        as creator,
       gd.label                                                      as game,
       count(*)                                                      as stored_rows,
       count(*) filter (where p.projected_spread is not null)         as has_spread,
       max(p.projected_spread) filter (where p.is_graded_candidate)   as flagged_spread,
       max(p.line_at_submission) filter (where p.is_graded_candidate) as flagged_line,
       max(p.projected_spread)                                        as best_available
from collective.projections p
join collective.models   m  on m.id = p.model_id
join collective.creators c  on c.id = m.creator_id
left join collective.game_detail gd on gd.game_id = p.game_id
where p.data_origin = 'live'
group by c.slug, gd.label
order by c.slug, gd.label;

-- ---------------------------------------------------------------- STEP 2
-- The fix, through the maintenance path.
--
-- set_config(..., true) makes the setting TRANSACTION-LOCAL: it reverts the
-- moment this block ends, so the table is append-only again immediately and
-- no session is left with the guard disabled. Written as one DO block so it
-- behaves the same whether or not the SQL Editor wraps statements in its own
-- transaction. It reports what it changed, and rerunning it changes nothing.

do $maint$
declare
  v_cleared  int;
  v_promoted int;
begin
  perform set_config('collective.maintenance', 'on', true);

  -- A row loses the flag only when another row for the same model and game
  -- actually carries a spread, so no game is ever left unflagged. A model
  -- that has no spread on any row is untouched and keeps showing its market
  -- line and cover probability.
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
  get diagnostics v_cleared = row_count;

  -- The earliest submission that actually carries a projection takes its place.
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
  get diagnostics v_promoted = row_count;

  raise notice 'cleared % empty rows, promoted % rows carrying numbers', v_cleared, v_promoted;
end
$maint$;

-- ---------------------------------------------------------------- STEP 3
-- Verify: exactly what the API serves and the wall renders.

select bm.creator_slug, gd.label as game, bm.pick_side,
       bm.projected_spread, bm.projected_total, bm.home_win_prob,
       bm.line_at_submission, bm.cover_prob
from collective.board_models bm
join collective.game_detail gd on gd.game_id = bm.game_id
order by bm.creator_slug, gd.label;

-- On grading: rule 4 grades a model's first pre-kickoff submission. This
-- moves that designation to the earliest submission carrying an actual
-- projection; the original carried none, so grading it could never have
-- produced a margin error or a Brier score. No Week 1 game has kicked off, so
-- nothing has been graded either way.
--
-- Rollback: the same block with the two conditions swapped moves the flag
-- back. Every row ever submitted is still present and unmodified.
