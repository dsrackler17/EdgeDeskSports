-- MODEL COLLECTIVE, UPGRADE 3: THE LIVE SUBMISSION FIX
--
-- Run this whole file once in the Supabase SQL editor. It is safe to run
-- twice. It does not touch any existing data.
--
-- What it fixes
--
-- Symptom: a creator's dry run returns 200 with every row resolved, but the
-- real submission to /v1/projections returns HTTP 500 server_error with null
-- details, every time.
--
-- Cause: ingest writes the projection rows first and their parent submissions
-- row last, inside one transaction, so the foreign key between them has to be
-- DEFERRABLE INITIALLY DEFERRED. Databases created from an early setup paste
-- got a plain (immediate) foreign key instead, so the very first projection
-- insert fails. The dry run never writes, which is exactly why it passes while
-- the live post fails.
--
-- Nothing was lost in those failed attempts. The function runs in a single
-- transaction, so a failure rolls the whole thing back: no submission row, no
-- projection rows, no partial slate.
--
-- This file also lets a creator repost a slate whose rows were quarantined.
-- Idempotency by payload hash was returning the original "all quarantined"
-- answer forever, so once you loaded the schedule the same file could never
-- resolve. Reposting is now allowed, and the first-submission lock still
-- guarantees only one graded pick per model per game, so nothing double counts.

-- Model Collective, migration 11: two ingest fixes found from a live failure.
--
-- 1) Repair the projections to submissions foreign key on databases created
--    from an early setup paste. Ingest writes the projection rows first and
--    the parent submissions row last, inside one transaction, so the
--    constraint MUST be deferrable. Where it is not, every live submission
--    fails with a foreign key violation (surfacing as HTTP 500) while the
--    dry run, which writes nothing, happily returns 200. Idempotent: it is a
--    no-op on databases that already have it right.
--
-- 2) Let a creator repost a slate whose rows were quarantined. Idempotency by
--    payload hash was returning the original "all quarantined" answer forever,
--    so once the schedule was loaded the same file could never resolve.

do $$
declare
  c record;
begin
  select con.conname, con.condeferrable into c
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace ns on ns.oid = rel.relnamespace
  where ns.nspname = 'collective' and rel.relname = 'projections'
    and con.contype = 'f' and pg_get_constraintdef(con.oid) like '%submissions(id)%';
  if not found then
    raise notice 'projections submission FK not found, nothing to repair';
  elsif c.condeferrable then
    raise notice 'projections submission FK is already deferrable, no change';
  else
    execute format('alter table collective.projections alter constraint %I deferrable initially deferred', c.conname);
    raise notice 'REPAIRED: % is now deferrable initially deferred', c.conname;
  end if;
end $$;

create or replace function collective.ingest_submission(p_key jsonb, p_envelope jsonb, p_dry boolean default false) returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  v_model_id uuid := (p_key->>'model_id')::uuid;
  v_key_id uuid := (p_key->>'key_id')::uuid;
  v_sport text := p_envelope->>'sport';
  v_season int;
  v_origin collective.data_origin;
  v_received timestamptz := now();
  v_hash text;
  v_max_rows int := collective.cfg_int('ingest.max_rows', 500);
  v_rows jsonb := coalesce(p_envelope->'rows', '[]'::jsonb);
  row_j jsonb;
  v_out jsonb := '[]'::jsonb;
  v_sub_id uuid;
  v_game uuid;
  v_kick timestamptz;
  v_late boolean;
  v_candidate boolean;
  v_status text;
  v_reason text;
  n_res int := 0; n_quar int := 0; n_late int := 0; n_first int := 0; n_move int := 0; n_rej int := 0;
  v_resp jsonb;
  v_existing record;
  v_hwp numeric; v_spread numeric;
  v_pick collective.pick_side; v_tside collective.total_side;
  v_line numeric; v_ptot numeric; v_phs numeric; v_pas numeric;
  v_conf numeric; v_cover numeric; v_week int; v_env_week int;
  v_gen timestamptz;
  v_retry int;
begin
  -- Identity comes from the key, payload strings are only checked (8.2).
  if p_envelope ? 'model' and (p_envelope->>'model') is distinct from (p_key->>'model_slug') then
    return jsonb_build_object('ok', false, 'code', 'invalid_payload',
      'message', format('This key submits model "%s", not "%s"', p_key->>'model_slug', p_envelope->>'model'));
  end if;
  if v_sport is distinct from (p_key->>'sport') then
    return jsonb_build_object('ok', false, 'code', 'invalid_payload',
      'message', format('This key submits %s, the envelope says %s', p_key->>'sport', coalesce(v_sport, 'nothing')));
  end if;
  begin
    v_season := (p_envelope->>'season')::int;
  exception when others then v_season := null; end;
  if v_season is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_payload', 'message', 'season is required and must be an integer');
  end if;
  begin
    v_origin := (p_envelope->>'data_origin')::collective.data_origin;
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'invalid_payload', 'message', 'data_origin must be live, backfill, or test');
  end;
  -- A test key can only ever write test data.
  if (p_key->>'kind') = 'test' then v_origin := 'test'; end if;

  -- Envelope-level optionals are never allowed to abort the submission.
  begin v_env_week := nullif(p_envelope->>'week','')::int; exception when others then v_env_week := null; end;
  begin v_gen := nullif(p_envelope->>'generated_at','')::timestamptz; exception when others then v_gen := null; end;

  if jsonb_typeof(v_rows) <> 'array' or jsonb_array_length(v_rows) = 0 then
    return jsonb_build_object('ok', false, 'code', 'invalid_payload', 'message', 'rows must be a non-empty array');
  end if;
  if jsonb_array_length(v_rows) > v_max_rows then
    return jsonb_build_object('ok', false, 'code', 'invalid_payload',
      'message', format('%s rows exceeds the %s row maximum', jsonb_array_length(v_rows), v_max_rows));
  end if;

  -- Idempotency: same model, same payload, same answer (with duplicate:true).
  -- The advisory lock serializes concurrent identical submissions so the
  -- loser sees the winner's row here instead of a unique violation later.
  v_hash := md5(coalesce(p_envelope->>'idempotency_key', v_rows::text || v_origin::text || v_season::text));
  if not p_dry then
    perform pg_advisory_xact_lock(hashtext(v_model_id::text || ':' || v_hash));
    select * into v_existing from collective.submissions
     where model_id = v_model_id and payload_hash = v_hash;
    if found then
      -- A replay of a payload that fully landed returns the original answer.
      -- But a payload whose rows were QUARANTINED is a different story: the
      -- usual reason is that the schedule had not been loaded yet, and the
      -- creator reposting the same file afterwards is a genuine retry, not a
      -- duplicate. Let it through under a distinct hash so the rows get
      -- another chance to resolve. The first-submission lock still decides
      -- what counts for grading, so a true double delivery becomes movement
      -- and can never create a second graded candidate.
      if coalesce((v_existing.response->'counts'->>'quarantined')::int, 0) = 0 then
        return coalesce(v_existing.response, '{}'::jsonb) || jsonb_build_object('ok', true, 'duplicate', true);
      end if;
      select count(*) into v_retry from collective.submissions
       where model_id = v_model_id
         and (payload_hash = v_hash or payload_hash like v_hash || ':retry%');
      v_hash := v_hash || ':retry' || v_retry;
    end if;
  end if;

  v_sub_id := gen_random_uuid();

  for row_j in select * from jsonb_array_elements(v_rows) loop
    v_status := null; v_reason := null; v_game := null; v_late := false; v_candidate := false;

    -- Field validation. A rejected row is reported, never stored.
    if coalesce(row_j->>'game_ref','') = '' or coalesce(row_j->>'home_team','') = ''
       or coalesce(row_j->>'away_team','') = '' or coalesce(row_j->>'kickoff','') = '' then
      v_status := 'rejected'; v_reason := 'game_ref, home_team, away_team, and kickoff are required';
    end if;
    if v_status is null then
      begin
        v_kick := (row_j->>'kickoff')::timestamptz;
      exception when others then
        v_status := 'rejected'; v_reason := 'kickoff is not a valid timestamp';
      end;
    end if;
    if v_status is null then
      -- Every optional field parses inside this block: a bad value rejects
      -- THIS row only and can never abort the whole submission.
      begin
        v_hwp   := nullif(row_j->>'home_win_probability','')::numeric;
        v_spread:= nullif(row_j->>'projected_spread','')::numeric;
        v_cover := nullif(row_j->>'cover_probability','')::numeric;
        v_line  := nullif(row_j->>'line_at_submission','')::numeric;
        v_ptot  := nullif(row_j->>'projected_total','')::numeric;
        v_phs   := nullif(row_j->>'proj_home_score','')::numeric;
        v_pas   := nullif(row_j->>'proj_away_score','')::numeric;
        v_conf  := nullif(row_j->>'confidence','')::numeric;
        v_pick  := nullif(row_j->>'pick_side','')::collective.pick_side;
        v_tside := nullif(row_j->>'total_side','')::collective.total_side;
        v_week  := coalesce(nullif(row_j->>'week','')::int, v_env_week);
        if v_hwp is not null and (v_hwp < 0 or v_hwp > 1) then
          v_status := 'rejected'; v_reason := 'home_win_probability must be between 0 and 1';
        elsif v_cover is not null and (v_cover < 0 or v_cover > 1) then
          v_status := 'rejected'; v_reason := 'cover_probability must be between 0 and 1';
        elsif v_cover is not null and v_line is null then
          -- A pick probability is meaningless without its line (9.3).
          v_status := 'rejected'; v_reason := 'cover_probability requires line_at_submission';
        elsif v_hwp is not null and v_spread is not null and
              ((v_hwp > 0.5 and v_spread > 3) or (v_hwp < 0.5 and v_spread < -3)) then
          -- Win probability is not spread probability (9.2): an obvious
          -- contradiction is a mapping error and gets rejected loudly.
          v_status := 'rejected';
          v_reason := 'home_win_probability contradicts projected_spread; check that the probability is moneyline and the spread is home convention';
        end if;
      exception when others then
        v_status := 'rejected'; v_reason := 'a field failed to parse; check number formats and pick_side/total_side values';
      end;
    end if;

    if v_status is null then
      v_game := collective.resolve_game_ref(v_sport, v_season, row_j->>'home_team', row_j->>'away_team', v_kick);
      if v_game is null then
        v_status := 'quarantined';
        if collective.resolve_team(v_sport, row_j->>'home_team') is null then v_reason := 'unknown_team_home';
        elsif collective.resolve_team(v_sport, row_j->>'away_team') is null then v_reason := 'unknown_team_away';
        else v_reason := 'unknown_game'; end if;
        n_quar := n_quar + 1;
      else
        select v_received > g.kickoff_at into v_late from collective.games g where g.id = v_game;
        if v_late then
          -- Stored, flagged, excluded from grading (8.6).
          v_status := 'late'; n_late := n_late + 1;
        else
          v_status := 'resolved'; n_res := n_res + 1;
        end if;
        v_candidate := (not v_late) and v_origin = 'live'
          and not exists (select 1 from collective.projections px
                          where px.model_id = v_model_id and px.game_id = v_game and px.is_graded_candidate);
        if v_status = 'resolved' then
          if v_candidate then n_first := n_first + 1; else n_move := n_move + 1; end if;
        end if;
      end if;
    else
      n_rej := n_rej + 1;
    end if;

    if not p_dry and v_status <> 'rejected' then
      begin
        insert into collective.projections (
          submission_id, model_id, game_id, raw_game_ref, raw_row,
          resolution_status, quarantine_reason, sport_code, season, week,
          pick_side, total_side, line_at_submission, projected_spread, projected_total,
          proj_home_score, proj_away_score, home_win_prob, cover_prob, confidence,
          data_origin, received_at, is_late, is_graded_candidate)
        values (
          v_sub_id, v_model_id, v_game, row_j->>'game_ref', row_j,
          case when v_status = 'quarantined' then 'quarantined' else 'resolved' end::collective.resolution_status,
          case when v_status = 'quarantined' then v_reason end,
          v_sport, v_season, v_week,
          v_pick, v_tside, v_line, v_spread, v_ptot, v_phs, v_pas,
          v_hwp, v_cover, v_conf,
          v_origin, v_received, coalesce(v_late, false), v_candidate);
      exception when unique_violation then
        -- Concurrent first-lock race: the index is the law, this row
        -- becomes movement.
        insert into collective.projections (
          submission_id, model_id, game_id, raw_game_ref, raw_row,
          resolution_status, quarantine_reason, sport_code, season, week,
          pick_side, total_side, line_at_submission, projected_spread, projected_total,
          proj_home_score, proj_away_score, home_win_prob, cover_prob, confidence,
          data_origin, received_at, is_late, is_graded_candidate)
        values (
          v_sub_id, v_model_id, v_game, row_j->>'game_ref', row_j,
          'resolved', null, v_sport, v_season, v_week,
          v_pick, v_tside, v_line, v_spread, v_ptot, v_phs, v_pas,
          v_hwp, v_cover, v_conf,
          v_origin, v_received, coalesce(v_late, false), false);
        if v_candidate then n_first := n_first - 1; n_move := n_move + 1; v_candidate := false; end if;
      end;
    end if;

    v_out := v_out || jsonb_build_object(
      'game_ref', row_j->>'game_ref',
      'status', v_status,
      'game_id', v_game,
      'reason', v_reason);
  end loop;

  v_resp := jsonb_build_object(
    'ok', true,
    'submission_id', case when p_dry then null else v_sub_id::text end,
    'received_at', v_received,
    'data_origin', v_origin,
    'counts', jsonb_build_object(
      'rows', jsonb_array_length(v_rows), 'resolved', n_res + n_late, 'quarantined', n_quar,
      'late', n_late, 'first', n_first, 'movement', n_move, 'rejected', n_rej),
    'rows', v_out,
    'duplicate', false);

  if not p_dry then
    insert into collective.submissions (id, model_id, api_key_id, received_at, data_origin,
      client_generated_at, payload_hash, n_rows, n_resolved, n_quarantined, n_late, response)
    values (v_sub_id, v_model_id, v_key_id, v_received, v_origin,
      v_gen, v_hash,
      jsonb_array_length(v_rows), n_res + n_late, n_quar, n_late, v_resp);
  end if;

  return v_resp;
end $$;
