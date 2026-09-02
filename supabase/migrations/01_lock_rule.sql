-- ===========================================================================
-- THE LOCK RULE — the latest submission received before the lock is the one
-- that counts. Every game locks LOCK_MINUTES (30) before kickoff.
--
-- WHAT CHANGES
--
--   Before: each model's FIRST pre-kickoff live submission on a game was the
--   graded one, forever. Anything posted after it was stored as movement and
--   never reached the wall. That stopped anyone moving a number after reading
--   the room — and it also stopped every creator who fixed a mapping, or
--   adjusted for weather, injuries or a line move, from ever correcting the
--   wall. Two creators reported the uploader as broken in one week. The group
--   decided: the latest upload is the master, and a lock-out before kickoff
--   protects the record.
--
--   After: each model's LATEST live submission received BEFORE THE LOCK is the
--   one the board shows, the consensus blends and the grader grades. Every
--   earlier submission stays stored as movement — nothing is ever deleted, the
--   store stays append-only, and no delete privilege is needed anywhere. A
--   submission received at or after the lock is stored, flagged late, and
--   excluded, whoever posts it. The lock is the anti-anchoring rule now.
--
-- WHAT THIS FILE DOES
--
--   1. a config key, submission.lock_minutes = 30, so the length of the lock
--      is one number in one place and /v1/meta can publish it;
--   2. two helper functions, collective.lock_minutes() and
--      collective.lock_at(kickoff), so every reader spells the lock the same
--      way;
--   3. the index the new reader predicate uses;
--   4. the predicate itself, written out once for the four readers and the
--      ingest (section 4), because the view and the routines that must adopt
--      it are not in this repository and cannot be rewritten from here.
--
--   No supersede column, no correction window, no maintenance function: the
--   earlier change set (01_supersede.sql) is withdrawn. It gave a creator 30
--   minutes AFTER posting to fix a slate; this gives them until 30 minutes
--   BEFORE kickoff, which is what was asked for, and needs no new column.
--
-- BEFORE RUNNING THIS: run 00_preflight.sql and fill in the names marked
-- >>>LIKE_THIS<<<. They cannot be read from this repository and are not
-- guessed at here on purpose. Every statement is idempotent.
-- ===========================================================================

begin;

-- 0 ---- refuse to run against a table this was not written for -------------
do $$
begin
  if to_regclass('collective.projections') is null then
    raise exception 'collective.projections does not exist — wrong project or wrong schema';
  end if;
end $$;

-- 1 ---- the one number: how long before kickoff a game locks --------------
--    collective.config is the same table admin.user_ids, econ.founder_count
--    and embed.upcoming_per_sport live in (get_config reads it). Its exact
--    column names come from preflight block 6. If the table stores JSON
--    values, the value is the JSON number 30; if text, the text '30'.
--    collective.lock_minutes() below reads it either way.
insert into collective.config (>>>CONFIG_KEY_COL<<<, >>>CONFIG_VALUE_COL<<<)
values ('submission.lock_minutes', >>>CONFIG_VALUE_30<<<)
on conflict (>>>CONFIG_KEY_COL<<<) do nothing;

-- 2 ---- the helpers every reader spells the lock with ---------------------
create or replace function collective.lock_minutes()
returns integer
language sql
stable
set search_path = collective, public
as $$
  select coalesce(
    nullif(regexp_replace(
      (select >>>CONFIG_VALUE_COL<<<::text from collective.config
        where >>>CONFIG_KEY_COL<<< = 'submission.lock_minutes' limit 1),
      '[^0-9]', '', 'g'), '')::integer,
    30);
$$;

comment on function collective.lock_minutes() is
  'Minutes before kickoff at which a game locks. A submission received at or '
  'after the lock is late: stored, flagged, never graded. Read from '
  'collective.config key submission.lock_minutes; 30 when unset.';

create or replace function collective.lock_at(p_kickoff timestamptz)
returns timestamptz
language sql
immutable
as $$
  select p_kickoff - make_interval(mins => collective.lock_minutes());
$$;

comment on function collective.lock_at(timestamptz) is
  'When a game with this kickoff locks. The latest live submission received '
  'before this instant is the one that counts.';

-- 3 ---- the index the reader will use --------------------------------------
--    "The latest live submission before the lock", per model per game: the
--    reader scans each (model, game) group from the newest row down, so the
--    index is descending on received_at. >>>MODEL_COL<<< / >>>GAME_COL<<< come
--    from preflight block 2.
create index if not exists projections_latest_slot_idx
  on collective.projections (>>>MODEL_COL<<<, >>>GAME_COL<<<, received_at desc);

-- 4 ---- THE PREDICATE, and the five places it goes -------------------------
--    Not executed here: the view and the routines below are not in this
--    repository (00_preflight.sql block 4 lists them by name). Each one
--    currently picks "the first pre-kickoff live submission per model per
--    game". Replace that with this, exactly:
--
--      select distinct on (p.>>>MODEL_COL<<<, p.>>>GAME_COL<<<) p.*
--        from collective.projections p
--        join collective.games g on g.>>>GAME_PK<<< = p.>>>GAME_COL<<<
--       where coalesce(p.data_origin, 'live') = 'live'
--         and p.received_at < collective.lock_at(g.>>>KICKOFF<<<)
--       order by p.>>>MODEL_COL<<<, p.>>>GAME_COL<<<, p.received_at desc;
--
--    (`distinct on` + `order by ... received_at desc` is "the latest one".)
--    movement_n for the row is simply
--
--      count(*) over (partition by p.>>>MODEL_COL<<<, p.>>>GAME_COL<<<)
--
--    counted over ALL of that model's rows on the game, late ones included,
--    so the wall's +n says how many submissions there were.
--
--    a. board_models (the view /v1/games reads) — this is what the wall and
--       the model page show. The row it returns per model per game becomes
--       the latest pre-lock one, and `late` becomes
--       received_at >= collective.lock_at(kickoff).
--    b. the grader / settlement run — grades the same row the wall shows.
--       Anything else and the record contradicts the board.
--    c. consensus — blends the same row.
--    d. the coverage counts — a model has "posted" a game when it holds a
--       live pre-lock row on it; a revision to a game already posted is not
--       a second projection (unchanged).
--    e. ingest_submission — sets `late` by the lock, not by kickoff:
--
--         late := v_received_at >= collective.lock_at(v_kickoff)
--
--       and answers `first` / `movement` against the new rule: a row is
--       `first` when the model had no live pre-lock row on the game, and
--       `movement` when it replaces one. Both counts keep their names on the
--       wire; the client already reads them as "new" and "replaced".
--
--    The retract endpoint needs no change: nothing has to be removed for a
--    correction to count any more.
--
-- 5 ---- what is NOT done: rows already stored --------------------------
--    Rows received between the lock and kickoff under the OLD rule were
--    legitimate then and may already be graded. This migration does not
--    re-flag them. If the group wants the lock applied to the current week
--    retroactively, that is one statement, run deliberately:
--
--      -- update collective.projections p
--      --    set late = true
--      --   from collective.games g
--      --  where g.>>>GAME_PK<<< = p.>>>GAME_COL<<<
--      --    and p.received_at >= collective.lock_at(g.>>>KICKOFF<<<)
--      --    and p.received_at <  g.>>>KICKOFF<<<
--      --    and coalesce(p.late, false) = false
--      --    and g.>>>KICKOFF<<< > now();   -- only games not yet played
--
--    Games already played keep the grade they were given.

commit;

-- ===========================================================================
-- WHAT THE CLIENT ALREADY DOES (collective/index.html, shipped with this)
--
--   * every /v1/games response is collapsed on arrival to one row per model
--     per game — the latest live row received before the lock — so the wall,
--     the model page, the record and the coverage all agree whether the
--     server has adopted the predicate yet or not. A feed that already
--     collapsed passes through unchanged; a feed that returns every row is
--     collapsed here.
--   * a row received after the lock that the server did not flag is flagged
--     late on the client, on a copy, so it is shown as LATE and never graded
--     on the page.
--   * the lock length is read from /v1/meta `lock_minutes` when present and
--     is 30 otherwise; every surface that names the rule prints that number.
--   * the dashboard says, before a post, which games it will replace numbers
--     on and which have already locked; the receipt says the same from the
--     server's own counts; the rules page, the legend and the wall's +n
--     state the lock rule.
-- ===========================================================================
