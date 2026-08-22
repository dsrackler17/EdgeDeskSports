-- Why the wall still shows "TEAM -" after a successful re-post
--
-- The receipt from the last dashboard post said:
--     8 matched, 0 first submissions, 8 revisions, 0 rejected
--
-- "0 first submissions" is the whole story. Your own grading rule, from
-- /v1/rules in collective_public:
--
--     "each model is graded on its first pre-kickoff live submission per
--      game, timestamped on server receipt. Later revisions are stored and
--      shown as movement, never regraded."
--
-- The first submission for every Week 1 game was the 4:23 PM upload: 16
-- rows, 0 matched, no numbers on any of them, because the column mapping
-- had not been fixed yet. Every upload since has been a REVISION. The row
-- of record still has no spread, so the board still renders a dash, and no
-- amount of re-posting changes that. The fix is to remove those empty rows
-- so the good submission becomes the first one.
--
-- Nothing is lost: none of these games has kicked off, so nothing has been
-- graded off the empty rows.
--
-- Steps 1 to 3 change nothing. Run them first.

-- ---------------------------------------------------------------- STEP 1
-- Confirm the column names on this database before the delete in step 4.

select column_name, data_type
from information_schema.columns
where table_schema = 'collective' and table_name = 'projections'
order by ordinal_position;

-- ---------------------------------------------------------------- STEP 2
-- The diagnosis, per game: what the FIRST stored row carries versus the
-- LATEST. Expect spread_on_first to be empty and spread_on_latest to hold
-- your number. That is the bug, and this query is the proof.

select
  p.game_id,
  count(*)                                                       as stored_rows,
  count(*) filter (where p.projected_spread is not null)          as rows_with_spread,
  min(p.received_at)                                              as first_at,
  max(p.received_at)                                              as latest_at,
  (array_agg(p.projected_spread order by p.received_at asc ))[1]  as spread_on_first,
  (array_agg(p.projected_spread order by p.received_at desc))[1]  as spread_on_latest
from collective.projections p
join collective.models   m on m.id = p.model_id
join collective.creators c on c.id = m.creator_id
where c.slug = 'edgedesk'            -- change the slug to check another model
  and p.data_origin = 'live'
group by p.game_id
order by p.game_id;

-- ---------------------------------------------------------------- STEP 3
-- What the API will actually serve for one game. This is the row the wall
-- renders, so it settles where the dash comes from.

select * from collective.board_models where game_id = '2026_01_NE_SEA';

--   projected_spread null here, but step 2 shows a good latest row
--     -> the board is pinned to the first submission. Continue to step 4.
--   projected_spread populated here, yet the wall still shows a dash
--     -> stop: the data is fine and the problem is in the read path.
--        Send back the output of:
--          select pg_get_viewdef('collective.board_models'::regclass, true);

-- ---------------------------------------------------------------- STEP 4
-- The fix. Deletes only rows that carry NO spread and NO market line, and
-- only when another row for the same model and game DOES carry a spread, so
-- a game can never be left with nothing. Every deleted row is copied to a
-- backup table first.

create table if not exists collective._projection_cleanup_backup(
  saved_at timestamptz not null default now(),
  row      jsonb       not null
);

with target as (
  select p.id, to_jsonb(p) as row
  from collective.projections p
  join collective.models   m on m.id = p.model_id
  join collective.creators c on c.id = m.creator_id
  where c.slug = 'edgedesk'          -- run again per creator, or drop this
                                     -- line to clean every model at once:
                                     -- the exists() below keeps it safe
    and p.data_origin = 'live'
    and p.projected_spread   is null
    and p.line_at_submission is null
    and exists (
      select 1
      from collective.projections q
      where q.model_id = p.model_id
        and q.game_id  = p.game_id
        and q.projected_spread is not null
    )
),
saved as (
  insert into collective._projection_cleanup_backup(row)
  select row from target
  returning 1
)
delete from collective.projections p
using target t
where p.id = t.id;

-- Re-running this deletes nothing: once the empty rows are gone there is
-- nothing left matching. It is safe to run twice.

-- ---------------------------------------------------------------- STEP 5
-- Verify. spread_on_first should now equal spread_on_latest, and
-- board_models should carry the numbers.

-- (re-run STEP 2, then:)
select game_id, pick_side, projected_spread, projected_total,
       home_win_prob, line_at_submission, cover_prob
from collective.board_models
where model_id in (
  select m.id from collective.models m
  join collective.creators c on c.id = m.creator_id
  where c.slug = 'edgedesk')
order by game_id;

-- Rollback: the removed rows are in collective._projection_cleanup_backup
-- as jsonb and can be re-inserted with jsonb_populate_record.

-- ---------------------------------------------------------------- NOTE
-- Worth fixing at the source too: a submission where every row carries no
-- spread and no line should not be accepted as a model's first submission
-- at all. The uploader now refuses to send one, but the API accepted these
-- and they became the row of record. A guard in ingest_submission would
-- have made this impossible rather than merely recoverable.
