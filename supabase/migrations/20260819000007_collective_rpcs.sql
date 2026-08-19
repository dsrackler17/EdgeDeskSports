-- Model Collective, migration 7: the RPC surface. These are the only write
-- paths into the schema; edge functions call them via PostgREST with the
-- service role. All SECURITY DEFINER, all revoked from everyone else.
-- Convention: business outcomes return jsonb {ok:true,...} or
-- {ok:false, code, message}; raising is reserved for genuine failures.

-- ---------------------------------------------------------------- helpers

create or replace function collective.is_admin(p_user uuid) returns boolean
language sql stable security definer set search_path = collective as $$
  select coalesce(collective.cfg('admin.user_ids') ? p_user::text, false)
$$;

create or replace function collective.slugify(p_name text) returns text
language sql immutable as $$
  -- Clamped to the 40-char slug constraint; a name that collapses to
  -- nothing or one char falls back to 'creator'.
  select case when length(s) < 2 then 'creator' else s end from (
    select trim(both '-' from left(trim(both '-' from
      regexp_replace(lower(trim(p_name)), '[^a-z0-9]+', '-', 'g')), 40)) as s
  ) x
$$;

create or replace function collective.get_config(p_key text) returns jsonb
language sql stable security definer set search_path = collective as $$
  select collective.cfg(p_key)
$$;

-- ---------------------------------------------------------------- keys

create or replace function collective.verify_key(p_prefix text, p_hash text) returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  k record;
begin
  select ak.id, ak.kind, ak.status, ak.key_hash,
         c.id as creator_id, c.slug as creator_slug, c.display_name, c.status as creator_status,
         m.id as model_id, m.slug as model_slug, m.name as model_name, m.sport_code
  into k
  from collective.api_keys ak
  join collective.creators c on c.id = ak.creator_id
  left join collective.models m on m.id = ak.model_id
  where ak.key_prefix = p_prefix;

  -- is distinct from: a null or empty hash must never read as a match.
  if not found or coalesce(p_hash, '') = '' or k.key_hash is distinct from p_hash then
    return jsonb_build_object('ok', false, 'code', 'invalid_key', 'message', 'Unknown key');
  end if;
  if k.status <> 'active' or k.creator_status <> 'active' then
    return jsonb_build_object('ok', false, 'code', 'revoked_key', 'message', 'This key has been revoked');
  end if;

  update collective.api_keys set last_used_at = now() where id = k.id;

  return jsonb_build_object('ok', true,
    'key_id', k.id, 'kind', k.kind,
    'creator_id', k.creator_id, 'creator_slug', k.creator_slug, 'creator_name', k.display_name,
    'model_id', k.model_id, 'model_slug', k.model_slug, 'model_name', k.model_name,
    'sport', k.sport_code,
    'limits', jsonb_build_object(
      'max_rows', collective.cfg_int('ingest.max_rows', 500),
      'max_bytes', collective.cfg_int('ingest.max_bytes', 524288),
      'rate_per_hour', collective.cfg_int('ingest.rate_per_hour', 60)));
end $$;

create or replace function collective.rate_check(p_key_id uuid, p_endpoint text) returns boolean
language plpgsql security definer set search_path = collective as $$
declare
  v_limit int := collective.cfg_int('ingest.rate_per_hour', 60);
  v_count int;
begin
  insert into collective.api_request_log (api_key_id, endpoint) values (p_key_id, p_endpoint);
  select count(*) into v_count from collective.api_request_log
   where api_key_id = p_key_id and at > now() - interval '1 hour';
  return v_count <= v_limit;
end $$;

create or replace function collective.rotate_key(p_creator_id uuid, p_new_prefix text, p_new_hash text, p_kind text default 'live') returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  v_model uuid;
begin
  select model_id into v_model from collective.api_keys
   where creator_id = p_creator_id and status = 'active'
   order by created_at desc limit 1;
  update collective.api_keys
     set status = 'revoked', revoked_at = now()
   where creator_id = p_creator_id and status = 'active';
  insert into collective.api_keys (creator_id, model_id, kind, key_prefix, key_hash)
  values (p_creator_id, v_model, p_kind, p_new_prefix, p_new_hash);
  -- Historical submissions keep their attribution: rows reference the old
  -- key id and stay exactly where they are (append-only).
  return jsonb_build_object('ok', true, 'prefix', p_new_prefix);
end $$;

-- ---------------------------------------------------------------- games

create or replace function collective.resolve_team(p_sport text, p_alias text) returns uuid
language sql stable security definer set search_path = collective as $$
  select ta.team_id from collective.team_aliases ta
  where ta.sport_code = p_sport and lower(trim(ta.alias)) = lower(trim(p_alias))
  limit 1
$$;

-- Teams plus season plus nearest kickoff within 48 hours. The creator's
-- raw identifier is stored verbatim regardless (rule 8.4); this only finds
-- the canonical id.
create or replace function collective.resolve_game_ref(
  p_sport text, p_season int, p_home text, p_away text, p_kickoff timestamptz
) returns uuid
language plpgsql stable security definer set search_path = collective as $$
declare
  v_home uuid; v_away uuid; v_game uuid;
begin
  v_home := collective.resolve_team(p_sport, p_home);
  v_away := collective.resolve_team(p_sport, p_away);
  if v_home is null or v_away is null or p_kickoff is null then return null; end if;
  select g.id into v_game
  from collective.games g
  where g.sport_code = p_sport and g.season = p_season
    and g.home_team_id = v_home and g.away_team_id = v_away
    and abs(extract(epoch from g.kickoff_at - p_kickoff)) <= 48 * 3600
  order by abs(extract(epoch from g.kickoff_at - p_kickoff))
  limit 1;
  return v_game;
end $$;

create or replace function collective.upsert_games(p_admin uuid, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  v_sport text := p_payload->>'sport';
  v_season int := (p_payload->>'season')::int;
  g jsonb;
  v_home uuid; v_away uuid;
  v_n int := 0;
  v_fail jsonb := '[]'::jsonb;
begin
  if not collective.is_admin(p_admin) then
    return jsonb_build_object('ok', false, 'code', 'forbidden', 'message', 'Not an admin account');
  end if;
  if not exists (select 1 from collective.sports where code = v_sport) then
    return jsonb_build_object('ok', false, 'code', 'invalid_payload', 'message', 'Unknown sport');
  end if;
  for g in select * from jsonb_array_elements(coalesce(p_payload->'games', '[]'::jsonb)) loop
    v_home := collective.resolve_team(v_sport, g->>'home');
    v_away := collective.resolve_team(v_sport, g->>'away');
    if v_home is null or v_away is null or (g->>'kickoff') is null then
      v_fail := v_fail || jsonb_build_object('game', g, 'reason',
        case when v_home is null then 'unknown_team_home'
             when v_away is null then 'unknown_team_away'
             else 'missing_kickoff' end);
      continue;
    end if;
    insert into collective.games (sport_code, season, week, kickoff_at, home_team_id, away_team_id)
    values (v_sport, v_season, nullif(g->>'week','')::int, (g->>'kickoff')::timestamptz, v_home, v_away)
    on conflict (sport_code, season, home_team_id, away_team_id, ((kickoff_at at time zone 'UTC')::date))
    do update set week = excluded.week, kickoff_at = excluded.kickoff_at;
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'upserted', v_n, 'failed', v_fail);
end $$;

create or replace function collective.settle_game(p_admin uuid, p_game_id uuid, p_result jsonb) returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  v_graded int;
begin
  if not collective.is_admin(p_admin) then
    return jsonb_build_object('ok', false, 'code', 'forbidden', 'message', 'Not an admin account');
  end if;
  if not exists (select 1 from collective.games where id = p_game_id) then
    return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'No such game');
  end if;
  insert into collective.results (game_id, home_score, away_score, closing_spread, closing_total, closing_home_ml_prob, source)
  values (p_game_id,
          (p_result->>'home_score')::int, (p_result->>'away_score')::int,
          nullif(p_result->>'closing_spread','')::numeric,
          nullif(p_result->>'closing_total','')::numeric,
          nullif(p_result->>'closing_home_ml_prob','')::numeric,
          coalesce(p_result->>'source', 'admin'))
  on conflict (game_id) do update
    set home_score = excluded.home_score, away_score = excluded.away_score,
        closing_spread = excluded.closing_spread, closing_total = excluded.closing_total,
        closing_home_ml_prob = excluded.closing_home_ml_prob,
        source = excluded.source, settled_at = now();
  update collective.games set status = 'final' where id = p_game_id;
  v_graded := collective.grade_game(p_game_id);
  return jsonb_build_object('ok', true, 'graded', v_graded);
end $$;

-- ---------------------------------------------------------------- ingest

-- The whole row-level pipeline in one transaction: validation, canonical
-- resolution (8.4), late flagging vs server receipt time (8.6), the first
-- submission lock (8.5), quarantine that never fails a submission, counts,
-- and idempotent replay. p_dry computes identical outcomes, writes nothing.
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
      return coalesce(v_existing.response, '{}'::jsonb) || jsonb_build_object('ok', true, 'duplicate', true);
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

-- ---------------------------------------------------------------- invites

create or replace function collective.mint_invite(
  p_admin uuid, p_prefill jsonb, p_founding boolean, p_share_bps int,
  p_max_uses int, p_note text, p_token_hash text, p_token_prefix text
) returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  v_days int := collective.cfg_int('invite.expiry_days', 30);
  v_id uuid;
  v_exp timestamptz;
begin
  if not collective.is_admin(p_admin) then
    return jsonb_build_object('ok', false, 'code', 'forbidden', 'message', 'Not an admin account');
  end if;
  v_exp := now() + make_interval(days => v_days);
  insert into collective.invite_tokens (token_hash, token_prefix, prefill, founding_member, referral_share_bps, max_uses, note, created_by, expires_at)
  values (p_token_hash, p_token_prefix, coalesce(p_prefill, '{}'::jsonb), coalesce(p_founding, false),
          p_share_bps, greatest(coalesce(p_max_uses, 1), 1), p_note, p_admin, v_exp)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'invite_id', v_id, 'expires_at', v_exp);
end $$;

create or replace function collective.invite_status(p_token_hash text) returns jsonb
language plpgsql stable security definer set search_path = collective as $$
declare
  t record;
begin
  select * into t from collective.invite_tokens where token_hash = p_token_hash;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'token_invalid', 'message', 'No such invite');
  end if;
  -- Dead tokens leak no invitee details: no prefill on these branches.
  if t.expires_at < now() then
    return jsonb_build_object('ok', true, 'status', 'expired', 'founding', t.founding_member,
      'prefill', '{}'::jsonb, 'expires_at', t.expires_at);
  end if;
  if t.use_count >= t.max_uses then
    return jsonb_build_object('ok', true, 'status', 'spent', 'founding', t.founding_member,
      'prefill', '{}'::jsonb, 'expires_at', t.expires_at);
  end if;
  return jsonb_build_object('ok', true, 'status', 'valid', 'founding', t.founding_member,
    'prefill', t.prefill, 'expires_at', t.expires_at);
end $$;

create or replace function collective.redeem_invite(
  p_token_hash text, p_user_id uuid, p_email text, p_profile jsonb,
  p_key_prefix text, p_key_hash text
) returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  t record;
  c record;
  v_creator_id uuid;
  v_model_id uuid;
  v_slug text;
  v_model_slug text;
  v_share int;
  v_host text;
  i int := 2;
begin
  select * into t from collective.invite_tokens where token_hash = p_token_hash for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'token_invalid', 'message', 'No such invite');
  end if;

  -- Idempotent per user: re-opening screen 3 must not burn the token or
  -- mint a second identity.
  select cr.*, m.slug as mslug, m.name as mname, m.sport_code as msport
  into c
  from collective.creators cr
  left join collective.models m on m.creator_id = cr.id
  where cr.user_id = p_user_id
  order by m.created_at limit 1;
  if found then
    return jsonb_build_object('ok', true, 'already_issued', true,
      'creator_id', c.id, 'creator_slug', c.slug, 'display_name', c.display_name,
      'founding', c.founding_member,
      'model_slug', c.mslug, 'model_name', c.mname, 'sport', c.msport);
  end if;

  if t.expires_at < now() then
    return jsonb_build_object('ok', false, 'code', 'token_expired', 'message', 'This invite has expired');
  end if;
  if t.use_count >= t.max_uses then
    return jsonb_build_object('ok', false, 'code', 'token_spent', 'message', 'This invite has already been used');
  end if;

  v_slug := collective.slugify(p_profile->>'display_name');
  while exists (select 1 from collective.creators where slug = v_slug) loop
    -- keep the disambiguated slug inside the 40-char constraint
    v_slug := left(collective.slugify(p_profile->>'display_name'), 40 - length(i::text) - 1) || '-' || i;
    i := i + 1;
  end loop;
  v_share := coalesce(t.referral_share_bps,
    case when t.founding_member
      then collective.cfg_int('share.founding_bps', 5000)
      else collective.cfg_int('share.referral_bps_default', 4000) end);

  insert into collective.creators (user_id, slug, display_name, description, website_url, x_handle, logo_url,
    founding_member, referral_share_bps, invite_token_id)
  values (p_user_id, v_slug, p_profile->>'display_name',
    nullif(p_profile->>'description',''), nullif(p_profile->>'website_url',''),
    nullif(p_profile->>'x_handle',''), nullif(p_profile->>'logo_url',''),
    t.founding_member, v_share, t.id)
  returning id into v_creator_id;

  v_model_slug := collective.slugify(p_profile->>'model_name');
  insert into collective.models (creator_id, slug, name, sport_code)
  values (v_creator_id, v_model_slug, p_profile->>'model_name', p_profile->>'sport')
  returning id into v_model_id;

  insert into collective.api_keys (creator_id, model_id, kind, key_prefix, key_hash)
  values (v_creator_id, v_model_id, 'live', p_key_prefix, p_key_hash);

  -- Their own site is allowlisted for the embed from the moment they join.
  if nullif(p_profile->>'website_url','') is not null then
    begin
      v_host := lower(regexp_replace(p_profile->>'website_url', '^(https?://[^/]+).*$', '\1'));
      if v_host like 'http%' then
        insert into collective.embed_installs (creator_id, origin) values (v_creator_id, v_host)
        on conflict do nothing;
      end if;
    exception when others then null; end;
  end if;

  update collective.invite_tokens set use_count = use_count + 1 where id = t.id;

  return jsonb_build_object('ok', true, 'already_issued', false,
    'creator_id', v_creator_id, 'creator_slug', v_slug,
    'display_name', p_profile->>'display_name', 'founding', t.founding_member,
    'model_id', v_model_id, 'model_slug', v_model_slug,
    'model_name', p_profile->>'model_name', 'sport', p_profile->>'sport');
end $$;

create or replace function collective.join_request(p_email text, p_note text, p_token text) returns jsonb
language plpgsql security definer set search_path = collective as $$
begin
  insert into collective.join_requests (email, note, token_seen) values (p_email, p_note, left(coalesce(p_token,''), 16));
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- quarantine

create or replace function collective.admin_resolve_quarantine(p_projection_id uuid, p_game_id uuid) returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  p record;
  v_kick timestamptz;
  v_late boolean;
  v_candidate boolean;
begin
  select * into p from collective.projections where id = p_projection_id and resolution_status = 'quarantined';
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'No quarantined row with that id');
  end if;
  select kickoff_at into v_kick from collective.games where id = p_game_id;
  if v_kick is null then
    return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'No such game');
  end if;
  v_late := p.received_at > v_kick;
  v_candidate := (not v_late) and p.data_origin = 'live'
    and not exists (select 1 from collective.projections px
                    where px.model_id = p.model_id and px.game_id = p_game_id and px.is_graded_candidate);
  -- The service maintenance path (rule 8.3): the only sanctioned mutation,
  -- and it may touch resolution fields only.
  perform set_config('collective.maintenance', 'on', true);
  update collective.projections
     set game_id = p_game_id, resolution_status = 'resolved', quarantine_reason = null,
         is_late = v_late, is_graded_candidate = v_candidate
   where id = p_projection_id;
  perform set_config('collective.maintenance', '', true);
  -- If the game already settled, grade the newly resolved row now.
  if exists (select 1 from collective.results where game_id = p_game_id) then
    perform collective.grade_game(p_game_id);
  end if;
  return jsonb_build_object('ok', true, 'resolved', 1, 'late', v_late, 'graded_candidate', v_candidate);
end $$;

-- After teaching the resolver a new alias: retry every quarantined row that
-- now resolves.
create or replace function collective.admin_reresolve(p_sport text) returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  q record;
  v_game uuid;
  v_n int := 0;
  r jsonb;
begin
  for q in select p.id, p.season, p.raw_row from collective.projections p
           where p.resolution_status = 'quarantined' and p.sport_code = p_sport loop
    v_game := collective.resolve_game_ref(p_sport, q.season,
      q.raw_row->>'home_team', q.raw_row->>'away_team',
      nullif(q.raw_row->>'kickoff','')::timestamptz);
    if v_game is not null then
      r := collective.admin_resolve_quarantine(q.id, v_game);
      if coalesce((r->>'ok')::boolean, false) then v_n := v_n + 1; end if;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'resolved', v_n);
end $$;

-- ---------------------------------------------------------------- attribution

create or replace function collective.record_touch(p_visitor text, p_creator_slug text, p_source text, p_origin text) returns void
language plpgsql security definer set search_path = collective as $$
declare
  v_creator uuid;
begin
  if coalesce(p_visitor, '') = '' then return; end if;
  select id into v_creator from collective.creators where slug = p_creator_slug and status = 'active';
  if v_creator is null then return; end if;
  -- First touch wins and is never overwritten (Section 5).
  if exists (select 1 from collective.attribution_touches where visitor_id = p_visitor) then return; end if;
  insert into collective.attribution_touches (visitor_id, creator_id, source, origin)
  values (p_visitor, v_creator, case when p_source in ('embed','link') then p_source else 'link' end, p_origin);
end $$;

create or replace function collective.lock_attribution(
  p_user_id uuid, p_email_hash text, p_visitor text, p_ref_slug text
) returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  v_creator uuid;
  v_source text := 'link';
  v_id uuid;
begin
  -- Locked at conversion, never moves. If a lock already exists it stands.
  select id, creator_id into v_id, v_creator from collective.attributions
   where (p_user_id is not null and subscriber_user_id = p_user_id)
      or (p_email_hash is not null and subscriber_email_hash = p_email_hash)
   limit 1;
  if v_id is not null then
    return jsonb_build_object('ok', true, 'attribution_id', v_id, 'creator_id', v_creator, 'existing', true);
  end if;

  -- Earliest recorded touch for this visitor wins; the checkout ref slug is
  -- the fallback when no touch was captured.
  select creator_id, source into v_creator, v_source
  from collective.attribution_touches
  where visitor_id = p_visitor and p_visitor is not null and p_visitor <> ''
  order by touched_at asc limit 1;

  if v_creator is null and coalesce(p_ref_slug, '') <> '' then
    select id into v_creator from collective.creators where slug = p_ref_slug and status = 'active';
  end if;
  if v_creator is null then
    return jsonb_build_object('ok', true, 'attribution_id', null, 'creator_id', null, 'existing', false);
  end if;

  insert into collective.attributions (subscriber_user_id, subscriber_email_hash, creator_id, visitor_id, source)
  values (p_user_id, p_email_hash, v_creator, p_visitor, v_source)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'attribution_id', v_id, 'creator_id', v_creator, 'existing', false);
end $$;

-- ---------------------------------------------------------------- billing

create or replace function collective.billing_upsert_subscriber(p_event jsonb) returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  v_id uuid;
  v_attr jsonb;
begin
  v_attr := collective.lock_attribution(
    nullif(p_event->>'user_id','')::uuid,
    nullif(p_event->>'email_hash',''),
    nullif(p_event->>'visitor',''),
    nullif(p_event->>'ref_slug',''));

  begin
    insert into collective.subscribers (user_id, email, status, plan, stripe_customer_id, stripe_subscription_id, attribution_id, current_period_end)
    values (
      nullif(p_event->>'user_id','')::uuid,
      nullif(p_event->>'email',''),
      coalesce(nullif(p_event->>'status',''), 'active')::collective.sub_status,
      nullif(p_event->>'plan',''),
      nullif(p_event->>'stripe_customer_id',''),
      nullif(p_event->>'stripe_subscription_id',''),
      nullif(v_attr->>'attribution_id','')::uuid,
      nullif(p_event->>'current_period_end','')::timestamptz)
    on conflict (stripe_subscription_id) do update
      set status = excluded.status,
          plan = coalesce(excluded.plan, collective.subscribers.plan),
          current_period_end = coalesce(excluded.current_period_end, collective.subscribers.current_period_end),
          canceled_at = case when excluded.status = 'canceled' then now() else collective.subscribers.canceled_at end
    returning id into v_id;
  exception when unique_violation then
    -- A returning subscriber: same user, a NEW Stripe subscription id.
    -- Update their row in place so the paying user regains entitlement and
    -- the original creator keeps the referral (attribution never moves).
    update collective.subscribers
       set stripe_subscription_id = nullif(p_event->>'stripe_subscription_id',''),
           stripe_customer_id = coalesce(nullif(p_event->>'stripe_customer_id',''), stripe_customer_id),
           status = coalesce(nullif(p_event->>'status',''), 'active')::collective.sub_status,
           plan = coalesce(nullif(p_event->>'plan',''), plan),
           current_period_end = coalesce(nullif(p_event->>'current_period_end','')::timestamptz, current_period_end),
           canceled_at = null
     where user_id = nullif(p_event->>'user_id','')::uuid
     returning id into v_id;
  end;
  return jsonb_build_object('ok', true, 'subscriber_id', v_id,
    'creator_id', v_attr->>'creator_id');
end $$;

create or replace function collective.billing_post_invoice(p jsonb) returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  s record;
  v_share int;
  v_amount int := coalesce(nullif(p->>'amount_cents','')::int, 0);
  v_month date := coalesce(nullif(p->>'period_month','')::date, date_trunc('month', now())::date);
  v_net int := collective.cfg_int('payout.net_days', 30);
  v_cents int;
begin
  select sub.id as subscriber_id, a.creator_id, c.referral_share_bps
  into s
  from collective.subscribers sub
  join collective.attributions a on a.id = sub.attribution_id
  join collective.creators c on c.id = a.creator_id
  where sub.stripe_subscription_id = p->>'stripe_subscription_id';
  if not found then
    return jsonb_build_object('ok', true, 'posted', false, 'reason', 'no attributed creator');
  end if;
  v_cents := (v_amount * s.referral_share_bps) / 10000;
  insert into collective.earnings_ledger (creator_id, subscriber_id, entry_type, amount_cents, period_month, available_at, stripe_ref, note)
  values (s.creator_id, s.subscriber_id, 'earning', v_cents, v_month,
          (v_month + interval '1 month') + make_interval(days => v_net),
          nullif(p->>'stripe_ref',''), p->>'note')
  on conflict (stripe_ref) where entry_type = 'earning' and stripe_ref is not null do nothing;
  return jsonb_build_object('ok', true, 'posted', true, 'creator_id', s.creator_id, 'amount_cents', v_cents);
end $$;

create or replace function collective.billing_post_refund(p jsonb) returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  e record;
  v_window int := collective.cfg_int('payout.clawback_days', 60);
begin
  select * into e from collective.earnings_ledger
   where entry_type = 'earning' and stripe_ref = p->>'stripe_ref';
  if not found then
    return jsonb_build_object('ok', true, 'posted', false, 'reason', 'no matching earning');
  end if;
  if e.created_at < now() - make_interval(days => v_window) then
    return jsonb_build_object('ok', true, 'posted', false, 'reason', 'outside the clawback window');
  end if;
  -- Stripe retries webhooks: one clawback per refund, ever. The clawback
  -- carries the SAME available_at as the earning it reverses so the pair
  -- always nets to zero in available_cents.
  if exists (select 1 from collective.earnings_ledger
             where entry_type = 'clawback' and stripe_ref = p->>'stripe_ref') then
    return jsonb_build_object('ok', true, 'posted', false, 'reason', 'already clawed back');
  end if;
  insert into collective.earnings_ledger (creator_id, subscriber_id, entry_type, amount_cents, period_month, available_at, stripe_ref, note)
  values (e.creator_id, e.subscriber_id, 'clawback', -e.amount_cents, e.period_month, e.available_at,
          p->>'stripe_ref', 'refund or chargeback clawback')
  on conflict (stripe_ref) where entry_type = 'clawback' and stripe_ref is not null do nothing;
  return jsonb_build_object('ok', true, 'posted', true, 'amount_cents', -e.amount_cents);
end $$;

-- ---------------------------------------------------------------- grants

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'collective'
  loop
    execute format('revoke execute on function %s from public', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
