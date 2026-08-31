-- ===========================================================================
-- SUPERSEDE — let a corrected projection actually replace the one it corrects,
-- without giving up either the append-only store or the anti-anchoring rule.
--
-- INTEGRATION.md option 2. Nothing is ever deleted: a superseded row stays in
-- the table, stays auditable, and stops counting. That is why this needs no
-- delete privilege anywhere and does not fight the append-only trigger.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--
--   It does not let a creator replace a number days later. Creators can read
--   each other's numbers before kickoff -- that is the whole reason the first
--   pre-kickoff submission is the graded one -- so open replacement would hand
--   everyone a way to post early, read the room, and quietly move. The record
--   is the product here; a record anyone can revise after seeing the others is
--   not worth grading and not worth selling.
--
--   So supersede is bounded two ways:
--     * a CREATOR may supersede their own row inside a correction window
--       (CORRECTION_WINDOW below, default 30 minutes). That covers the case
--       this was written for -- post a slate, notice a column was mapped
--       wrong, fix it -- and covers nothing else.
--     * an ADMIN may supersede any pre-kickoff row through the maintenance
--       path, which is what the append-only trigger's own error message
--       ("use the service maintenance path") has always pointed at.
--
--   Widening the window to 'infinity' turns this into open replacement. That
--   is a product decision about what the record claims, not a technical one,
--   and it is one line -- but read the paragraph above before taking it.
--
-- BEFORE RUNNING THIS: run 00_preflight.sql and fill in the four names marked
-- >>>LIKE_THIS<<<. They cannot be read from this repository and are not
-- guessed at here on purpose. Every statement is idempotent.
-- ===========================================================================

begin;

-- 0 ---- refuse to run against a table this was not written for -------------
--    A migration that half-applies to the wrong schema is worse than one that
--    does not run. This stops before touching anything.
do $$
begin
  if to_regclass('collective.projections') is null then
    raise exception 'collective.projections does not exist — wrong project or wrong schema';
  end if;
end $$;

-- 1 ---- the column ---------------------------------------------------------
--    Two columns and no foreign key. WHICH row replaced a superseded one is
--    derivable (it is the next live submission from the same model on the same
--    game), and inventing an FK here would need the primary key's type, which
--    is exactly the thing this file refuses to guess.
alter table collective.projections
  add column if not exists superseded_at     timestamptz,
  add column if not exists superseded_reason text;

comment on column collective.projections.superseded_at is
  'When this submission stopped counting. Non-null rows are excluded from '
  'grading, consensus, the board and coverage, and are never deleted — the '
  'store stays append-only and the row stays auditable.';

-- 2 ---- the index the reader will use --------------------------------------
--    "The first pre-kickoff submission that has not been superseded", per
--    model per game. Partial, so it indexes only the rows that can win.
--    >>>MODEL_COL<<< and >>>GAME_COL<<< come from preflight block 2.
create index if not exists projections_live_slot_idx
  on collective.projections (>>>MODEL_COL<<<, >>>GAME_COL<<<, received_at)
  where superseded_at is null;

-- 3 ---- the maintenance path the trigger names -----------------------------
--    security definer, so it is allowed where an ordinary caller is not — and
--    narrow, so being allowed does not mean being able to do anything else.
--    It cannot touch a row after kickoff, cannot touch another creator's row
--    unless the caller is an admin, and cannot delete anything at all.
--
--    >>>PK_COL<<< / >>>PK_TYPE<<< come from preflight block 2, >>>KICKOFF<<<
--    is whatever the games table calls kickoff (kickoff_at in the client).
create or replace function collective.supersede_projection(
  p_id     >>>PK_TYPE<<<,
  p_reason text default null,
  p_actor  uuid default auth.uid()
) returns table (superseded >>>PK_TYPE<<<, superseded_at timestamptz)
language plpgsql
security definer
set search_path = collective, public
as $$
declare
  v_window constant interval := interval '30 minutes';  -- CORRECTION_WINDOW
  v_row    collective.projections%rowtype;
  v_admin  boolean;
  v_kick   timestamptz;
begin
  select * into v_row from collective.projections where >>>PK_COL<<< = p_id;
  if not found then
    raise exception 'no such projection: %', p_id using errcode = 'P0002';
  end if;

  if v_row.superseded_at is not null then
    -- already done; say so rather than move the timestamp
    return query select p_id, v_row.superseded_at;
    return;
  end if;

  -- an admin, by the same list the admin console already checks
  select coalesce(
      (select (value::jsonb ? p_actor::text)
         from collective.config where key = 'admin.user_ids'), false)
    into v_admin;

  -- never after kickoff: the record is fixed the moment a game starts
  select g.>>>KICKOFF<<< into v_kick
    from collective.games g where g.id = v_row.>>>GAME_COL<<<;
  if v_kick is not null and v_kick <= now() then
    raise exception 'that game has kicked off; its record is closed'
      using errcode = 'P0001';
  end if;

  if not v_admin then
    -- a creator may correct only their OWN row, and only inside the window.
    -- Both halves matter: without the first anyone could edit anyone, and
    -- without the second the anti-anchoring rule is gone.
    if v_row.created_by is distinct from p_actor then
      raise exception 'that projection belongs to another creator'
        using errcode = 'P0001';
    end if;
    if v_row.received_at < now() - v_window then
      raise exception
        'the % correction window on that submission has passed — a later '
        'change is stored as movement, because the first pre-kickoff '
        'submission is the graded one', v_window
        using errcode = 'P0001';
    end if;
  end if;

  update collective.projections
     set superseded_at     = now(),
         superseded_reason = coalesce(p_reason, case when v_admin
                               then 'admin maintenance' else 'creator correction' end)
   where >>>PK_COL<<< = p_id;

  return query select p_id, now()::timestamptz;
end $$;

revoke all on function collective.supersede_projection(>>>PK_TYPE<<<, text, uuid) from public;
grant execute on function collective.supersede_projection(>>>PK_TYPE<<<, text, uuid) to authenticated;

commit;

-- ===========================================================================
-- 4 ---- WHAT STILL HAS TO CHANGE IN THE EDGE FUNCTIONS
--
-- The column and the function are inert on their own. Three readers and one
-- writer decide whether any of this is visible, and none of them is in this
-- repository. Preflight block 4 lists every routine that names projections;
-- these are the four that matter.
--
--   collective_public   /v1/games
--       The board's row per model per game. Add `superseded_at is null` to
--       whatever picks the first pre-kickoff live submission. This is the one
--       that makes a correction appear on the wall, and until it lands
--       nothing else here is visible to a creator.
--
--   the grader / settlement run
--       Same predicate, same reason. It must never grade a row the board is
--       not showing, or the record and the board disagree about what was
--       picked — which is worse than either bug on its own.
--
--   consensus + coverage
--       Same predicate. A superseded row must not be averaged into the
--       consensus line or counted toward a model's slate coverage; both are
--       claims about what the model actually stands behind.
--
--   collective_ingest   /v1/projections/retract
--       Stop issuing the PostgREST DELETE that the trigger has always
--       refused. Call collective.supersede_projection(id) per row instead,
--       and — INTEGRATION.md item 3 — make the DRY RUN answer from that same
--       path, so `would_remove` can never again count rows the confirmed call
--       is not allowed to touch. Rows outside the correction window come back
--       refused with the message above, which is the true answer and the one
--       the uploader can now show.
--
-- 5 ---- ORDER OF DEPLOYMENT
--
--   1. this migration                      (inert: nothing reads the column)
--   2. the three readers                   (inert: nothing writes it yet)
--   3. collective_ingest's retract         (now corrections take effect)
--
--   Backwards at any point. Rolling back is `update collective.projections
--   set superseded_at = null` — every row is still there, which is the point
--   of doing it this way rather than with a delete privilege.
--
-- 6 ---- THE CLIENT IS ALREADY READY FOR THIS
--
--   collective/index.html states the current rule in three places — the
--   pre-post scan, the receipt's movement note, and the +n on the wall row.
--   When step 3 lands, a correction inside the window stops being movement
--   and those three surfaces stop firing on it by themselves: they are driven
--   by the server's own `movement` count and by movement_n, not by a flag the
--   page sets. Nothing has to be un-shipped for this to become true.
-- ===========================================================================
