-- ===========================================================================
-- collective.board_models — the view the whole board is built from.
--
-- Run AFTER 01_supersede.sql: this references superseded_at.
--
-- Two changes, and one thing left deliberately alone.
--
-- 1. movement_n. The view carried no such column, so a creator asking the only
--    question that matters to them -- "did my re-upload land?" -- had no
--    answer available anywhere on the board, at any price. It is counted here,
--    from the rows the WHERE clause below is about to throw away.
--
--    That last part is why it is a scalar subquery and not a window function.
--    A count OVER (partition by model_id, game_id) is computed AFTER the WHERE
--    clause, and the WHERE clause is precisely what drops every revision -- so
--    the window would faithfully count 1 on every row and confidently report
--    that no revision had ever arrived.
--
-- 2. superseded_at. A superseded row leaves the board, grading, consensus and
--    coverage without being deleted from anything.
--
-- LEFT ALONE: `is_graded_candidate or is_late`. It stays, because it is the
-- anti-anchoring rule -- the board shows the first pre-kickoff submission and
-- a revision does not displace it. Two creators reported that as a broken
-- uploader in one week, and the answer is that the board now SAYS a revision
-- arrived (movement_n) rather than that the rule should change.
--
-- The column list and its order are unchanged apart from movement_n being
-- appended, so nothing downstream that selects by name can break.
-- ===========================================================================

begin;

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema='collective' and table_name='projections'
                    and column_name='superseded_at') then
    raise exception 'run 01_supersede.sql first — projections.superseded_at is missing';
  end if;
end $$;

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
    p.cover_prob,
    /* HOW MANY SUBMISSIONS THIS MODEL HAS MADE ON THIS GAME.

       Counted over every surviving live, resolved submission -- including the
       revisions the WHERE clause below excludes from the board, which is the
       entire point of the number. A superseded row is not counted: it has been
       withdrawn, and counting it would tell a creator a correction is still
       outstanding after they made it.

       This is a count of submissions, not a projection, so it is not a paid
       number and collective_public returns it on locked rows too. A locked
       reader learning that a model revised a game learns nothing they could
       bet on; withholding it would put a creator's own "did my upload land?"
       behind the paywall. */
    ( SELECT count(*)
        FROM collective.projections p2
       WHERE p2.model_id = p.model_id
         AND p2.game_id = p.game_id
         AND p2.superseded_at IS NULL
         AND p2.data_origin = 'live'::collective.data_origin
         AND p2.resolution_status = 'resolved'::collective.resolution_status
    ) AS movement_n
   FROM collective.projections p
     JOIN collective.models m ON m.id = p.model_id AND m.is_listed
     JOIN collective.creators c ON c.id = m.creator_id AND c.is_listed AND c.status = 'active'::collective.creator_status
     LEFT JOIN collective.grades gr ON gr.projection_id = p.id
  WHERE p.resolution_status = 'resolved'::collective.resolution_status
    AND p.data_origin = 'live'::collective.data_origin
    AND p.superseded_at IS NULL
    AND (p.is_graded_candidate OR p.is_late);

commit;

-- ---------------------------------------------------------------------------
-- CHECK IT, before trusting the board.
--
-- 1. Every model/game that has ever been posted twice. This is the population
--    the +n marker is about, and it should be non-empty on any week where a
--    creator re-uploaded -- if it is empty, no revision has ever reached the
--    database and the problem is upstream in collective_ingest, not here.
--
-- select c.slug, m.slug, p.game_id, count(*) as submissions
--   from collective.projections p
--   join collective.models m on m.id = p.model_id
--   join collective.creators c on c.id = m.creator_id
--  where p.data_origin = 'live' and p.resolution_status = 'resolved'
--    and p.superseded_at is null
--  group by 1,2,3 having count(*) > 1
--  order by submissions desc limit 50;
--
-- 2. The same games as the board sees them. movement_n here must equal the
--    count above, and there must be exactly ONE non-late row per model/game.
--    More than one means a model is rendering twice on a game.
--
-- select creator_slug, model_slug, game_id,
--        count(*) filter (where not is_late) as board_rows,
--        max(movement_n) as movement_n
--   from collective.board_models
--  group by 1,2,3 having max(movement_n) > 1
--  order by movement_n desc limit 50;
-- ---------------------------------------------------------------------------
