-- Why the wall still shows "TEAM -" after a successful re-post
--
-- The receipt from the dashboard said: "0 first submissions, 8 revisions".
-- Grading rule 4, from /v1/rules:
--
--     "each model is graded on its first pre-kickoff live submission per
--      game, timestamped on server receipt. Later revisions are stored and
--      shown as movement, never regraded."
--
-- collective_public renders every row board_models returns for a game, with
-- no de-duplication anywhere in the edge function. One row per model appears
-- on the wall, so board_models is already collapsing to one row per model and
-- game — and the one it picks is an early submission made before the column
-- mapping was fixed, carrying no numbers. Later uploads are revisions sitting
-- behind it. Re-posting cannot fix this; the empty row has to go.
--
-- Nothing is lost: no Week 1 game has kicked off, so nothing has been graded
-- off these rows.
--
-- SCHEMA NOTE: projections.game_id is a uuid referencing the games table.
-- The nflverse-style string ("2026_01_NE_SEA") is game_ref. Comparing
-- game_id to that string is what produced
--   ERROR: invalid input syntax for type uuid: "2026_01_NE_SEA"
-- so every query below joins through game_detail for a readable label.
--
-- Steps 1 to 3 change nothing.

-- ---------------------------------------------------------------- STEP 1
-- How board_models chooses its row, and the exact projections columns.
-- This is the decisive output: look at the ORDER BY under a DISTINCT ON.

select pg_get_viewdef('collective.board_models'::regclass, true);

select string_agg(column_name, ', ' order by ordinal_position) as projections_columns
from information_schema.columns
where table_schema = 'collective' and table_name = 'projections';

-- ---------------------------------------------------------------- STEP 2
-- Per game: what the FIRST stored row carries versus the LATEST.
-- Expect spread_on_first empty and spread_on_latest holding your number.

select coalesce(g.label, '(unresolved: ' || p.game_ref || ')')       as game,
       count(*)                                                      as stored_rows,
       count(*) filter (where p.projected_spread is not null)         as with_spread,
       min(p.received_at)                                             as first_at,
       (array_agg(p.projected_spread order by p.received_at asc ))[1] as spread_on_first,
       (array_agg(p.projected_spread order by p.received_at desc))[1] as spread_on_latest,
       string_agg(distinct p.resolution_status, ',')                  as statuses
from collective.projections p
join collective.models   m on m.id = p.model_id
join collective.creators c on c.id = m.creator_id
left join collective.game_detail g on g.game_id = p.game_id
where c.slug = 'edgedesk'          -- change the slug for another model
  and p.data_origin = 'live'
group by 1
order by 1;

-- ---------------------------------------------------------------- STEP 3
-- What the API actually serves. These are the rows the wall renders, so
-- this settles where the dash comes from.

select g.label, bm.pick_side, bm.projected_spread, bm.projected_total,
       bm.home_win_prob, bm.line_at_submission, bm.cover_prob, bm.received_at
from collective.board_models bm
join collective.game_detail g on g.game_id = bm.game_id
where bm.creator_slug = 'edgedesk'
  and g.season = 2026 and g.week = 1
order by g.kickoff_at, bm.received_at;

--   numbers empty here, but step 2 shows a good latest row
--     -> the board is pinned to an early empty submission. Run step 4.
--   numbers populated here, yet the wall still shows a dash
--     -> stop. The data is fine and the problem is downstream.

-- ---------------------------------------------------------------- STEP 4
-- The fix. Deletes only rows carrying NO spread and NO market line, and only
-- when another row for the same model and game DOES carry a spread, so a game
-- can never be left with nothing. Deleted rows are copied to a backup table.
-- Quarantined rows (game_id null) are never touched: board_models does not
-- serve them, so they are not the cause and deleting them would lose the
-- record of what was sent.

create table if not exists collective._projection_cleanup_backup(
  saved_at timestamptz not null default now(),
  row      jsonb       not null
);

with target as (
  select p.id, to_jsonb(p) as row
  from collective.projections p
  join collective.models   m on m.id = p.model_id
  join collective.creators c on c.id = m.creator_id
  where c.slug = 'edgedesk'        -- run again per creator, or drop this line
                                   -- to clean every model at once: the
                                   -- exists() below keeps that safe
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

-- Safe to run twice: once the empty rows are gone, nothing matches.

-- ---------------------------------------------------------------- STEP 5
-- Verify: re-run STEP 3. Every game should now carry its numbers.
--
-- Rollback: the removed rows are in collective._projection_cleanup_backup as
-- jsonb, restorable with jsonb_populate_record.

-- ---------------------------------------------------------------- NOTE
-- Worth fixing at the source: a submission where no row carries a spread or a
-- market line should never become a model's first submission. The uploader
-- now refuses to send one, but ingest_submission accepted these and made them
-- the row of record.
