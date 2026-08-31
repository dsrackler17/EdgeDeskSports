-- ===========================================================================
-- SUPERSEDE — let a corrected projection actually replace the one it corrects,
-- without giving up either the append-only store or the anti-anchoring rule.
--
-- No placeholders left. The names below are read from the real
-- collective.board_models definition:
--
--   collective.projections  id, model_id, game_id, pick_side, projected_spread,
--                           projected_total, home_win_prob, line_at_submission,
--                           cover_prob, received_at, is_late,
--                           is_graded_candidate, resolution_status, data_origin
--   collective.models       id, slug, creator_id, is_listed
--   collective.creators     id, slug, user_id, is_listed, status
--   collective.grades       projection_id, pick_result, margin_error, brier
--
-- WHY THE BOARD NEVER SHOWED A RE-UPLOAD. board_models selects
--
--     where p.resolution_status = 'resolved'
--       and p.data_origin = 'live'
--       and (p.is_graded_candidate or p.is_late)
--
-- A re-upload before kickoff is resolved and live but is NOT the graded
-- candidate and is NOT late, so it matches neither arm of that last clause and
-- the view drops it on the floor. The creator's corrected numbers are stored,
-- correct, and invisible. Nothing anywhere reports this.
--
-- THE ONE THAT MATTERS FOR SUPERSEDE. Because the board is driven by
-- is_graded_candidate, marking the first row superseded and stopping there
-- would remove the model from that game ENTIRELY rather than replace its
-- numbers. So superseding must also PROMOTE the next eligible submission.
-- That promotion is the feature; the flag is only bookkeeping.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--
--   It does not let a creator replace a number days later. Creators can read
--   each other's numbers before kickoff -- that is the whole reason the first
--   pre-kickoff submission is the graded one -- so open replacement would hand
--   everyone a way to post early, read the room, and quietly move. The record
--   is the product here.
--
--   So supersede is bounded two ways:
--     * a CREATOR may supersede their own row inside a correction window
--       (CORRECTION_WINDOW below, default 30 minutes);
--     * an ADMIN may supersede any pre-kickoff row through the maintenance
--       path, which is what the append-only trigger's own error message
--       ("use the service maintenance path") has always pointed at.
--
--   Widening the window to 'infinity' turns this into open replacement. That
--   is a product decision about what the record claims, not a technical one.
--
-- Every statement is idempotent. Run 00_preflight.sql first if you want the
-- trigger definition and the primary key type confirmed on the record.
-- ===========================================================================

begin;

-- 0 ---- refuse to run against a schema this was not written for ------------
do $$
declare v_type text;
begin
  if to_regclass('collective.projections') is null then
    raise exception 'collective.projections does not exist — wrong project or wrong schema';
  end if;
  select data_type into v_type
    from information_schema.columns
   where table_schema='collective' and table_name='projections' and column_name='id';
  if v_type is distinct from 'uuid' then
    raise exception
      'collective.projections.id is % , not uuid — change supersede_projection''s p_id type to match before running this',
      coalesce(v_type,'missing');
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema='collective' and table_name='projections'
                    and column_name='is_graded_candidate') then
    raise exception 'collective.projections.is_graded_candidate is missing — board_models depends on it';
  end if;
end $$;

-- 1 ---- the columns --------------------------------------------------------
alter table collective.projections
  add column if not exists superseded_at     timestamptz,
  add column if not exists superseded_reason text;

comment on column collective.projections.superseded_at is
  'When this submission stopped counting. Non-null rows are excluded from the '
  'board, grading, consensus and coverage, and are never deleted — the store '
  'stays append-only and the row stays auditable.';

-- 2 ---- the index the board will use ---------------------------------------
create index if not exists projections_live_slot_idx
  on collective.projections (model_id, game_id, received_at)
  where superseded_at is null;

-- 3 ---- the maintenance path the append-only trigger names -----------------
create or replace function collective.supersede_projection(
  p_id     uuid,
  p_reason text default null,
  p_actor  uuid default auth.uid()
) returns table (superseded uuid, promoted uuid, superseded_at timestamptz)
language plpgsql
security definer
set search_path = collective, public
as $$
declare
  v_window constant interval := interval '30 minutes';   -- CORRECTION_WINDOW
  v_row    collective.projections%rowtype;
  v_admin  boolean;
  v_owner  uuid;
  v_kick   timestamptz;
  v_next   uuid;
  v_now    timestamptz := now();
begin
  select * into v_row from collective.projections where id = p_id;
  if not found then
    raise exception 'no such projection: %', p_id using errcode = 'P0002';
  end if;

  if v_row.superseded_at is not null then
    -- already done; report it rather than move the timestamp
    return query select p_id, null::uuid, v_row.superseded_at;
    return;
  end if;

  -- an admin, by the same list the admin console already checks
  select coalesce(
      (select (value::jsonb ? p_actor::text)
         from collective.config where key = 'admin.user_ids'), false)
    into v_admin;

  -- never after kickoff: the record is fixed the moment a game starts
  select g.kickoff_at into v_kick
    from collective.games g where g.id = v_row.game_id;
  if v_kick is not null and v_kick <= v_now then
    raise exception 'that game has kicked off; its record is closed'
      using errcode = 'P0001';
  end if;

  if not v_admin then
    -- Ownership runs projections -> models -> creators.user_id. There is no
    -- created_by on projections; the model is what a submission belongs to.
    select c.user_id into v_owner
      from collective.models m
      join collective.creators c on c.id = m.creator_id
     where m.id = v_row.model_id;
    if v_owner is null or v_owner is distinct from p_actor then
      raise exception 'that projection belongs to another creator'
        using errcode = 'P0001';
    end if;
    if v_row.received_at < v_now - v_window then
      raise exception
        'the % correction window on that submission has passed — a later '
        'change is stored as movement, because the first pre-kickoff '
        'submission is the graded one', v_window
        using errcode = 'P0001';
    end if;
  end if;

  update collective.projections
     set superseded_at     = v_now,
         superseded_reason = coalesce(p_reason, case when v_admin
                               then 'admin maintenance' else 'creator correction' end)
   where id = p_id;

  /* PROMOTE THE REPLACEMENT. board_models is driven by is_graded_candidate,
     so clearing the flag without handing it on would take the model off that
     game altogether instead of replacing its numbers -- a correction that
     deletes you from the board is worse than no correction at all.

     The successor is the earliest surviving live, resolved, pre-kickoff
     submission from the same model on the same game. A late row is never
     promoted: it did not beat kickoff and the rules exclude it. If there is
     no successor the model simply has no row, which is the correct outcome
     for a retraction with nothing behind it. */
  if v_row.is_graded_candidate then
    select p2.id into v_next
      from collective.projections p2
     where p2.model_id = v_row.model_id
       and p2.game_id  = v_row.game_id
       and p2.id      <> p_id
       and p2.superseded_at is null
       and p2.data_origin = 'live'::collective.data_origin
       and p2.resolution_status = 'resolved'::collective.resolution_status
       and not p2.is_late
     order by p2.received_at asc
     limit 1;
    if v_next is not null then
      update collective.projections set is_graded_candidate = true where id = v_next;
    end if;
  end if;

  return query select p_id, v_next, v_now;
end $$;

revoke all on function collective.supersede_projection(uuid, text, uuid) from public;
grant execute on function collective.supersede_projection(uuid, text, uuid) to authenticated;

commit;

-- ===========================================================================
-- NEXT: 02_board_models.sql, which teaches the board about both of these --
-- the superseded filter and movement_n. Until it runs, this migration is
-- inert: nothing reads superseded_at.
--
-- THEN: collective_ingest's /v1/projections/retract. Stop issuing the
-- PostgREST DELETE the trigger has always refused; call
-- collective.supersede_projection(id) per row, and make the DRY RUN answer
-- from that same path so `would_remove` can never again count rows the
-- confirmed call is not allowed to touch.
--
-- Rolling back is `update collective.projections set superseded_at = null`.
-- Every row is still there, which is the point of doing it this way.
-- ===========================================================================
