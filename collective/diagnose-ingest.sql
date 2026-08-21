-- MODEL COLLECTIVE: INGEST DIAGNOSTIC
--
-- Run this whole file in the Supabase SQL editor and send back the table it
-- prints. Nothing is saved: the live attempt is rolled back on purpose, so no
-- submission or projection row survives.

create or replace function collective.diagnose_ingest(p_slug text default 'mustbemoose')
returns table (step text, finding text)
language plpgsql as $fn$
declare
  c record; k record; m record; g record; fk record;
  kctx jsonb; env jsonb; r jsonb; n int;
  ok_live boolean := false;
  live_state text; live_msg text;
begin
  -- 1. Did the deferrable foreign key repair land?
  select con.conname as nm, con.condeferrable as d1, con.condeferred as d2 into fk
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace ns on ns.oid = rel.relnamespace
  where ns.nspname = 'collective' and rel.relname = 'projections'
    and con.contype = 'f' and pg_get_constraintdef(con.oid) like '%submissions(id)%';
  if not found then
    return query select '1 foreign key'::text, 'NOT FOUND (unexpected)'::text;
  else
    return query select '1 foreign key'::text,
      format('%s deferrable=%s deferred=%s %s', fk.nm, fk.d1, fk.d2,
             case when fk.d1 and fk.d2 then '(correct)' else '<<< WRONG, upgrade 3 has not taken effect' end);
  end if;

  -- 2. Creator, models, keys.
  select * into c from collective.creators where slug = p_slug;
  if not found then
    return query select '2 creator'::text, format('"%s" NOT FOUND, stopping', p_slug);
    return;
  end if;
  return query select '2 creator'::text, format('%s  status=%s  user_id=%s', c.slug, c.status, c.user_id);

  for m in select * from collective.models where creator_id = c.id loop
    return query select '3 model'::text, format('slug=%s  name=%s  sport=%s', m.slug, m.name, m.sport_code);
  end loop;
  select count(*) into n from collective.models where creator_id = c.id;
  if n = 0 then return query select '3 model'::text, 'NONE, stopping'::text; return; end if;

  for k in select * from collective.api_keys where creator_id = c.id and status = 'active' loop
    return query select '4 active key'::text,
      format('prefix=%s kind=%s model_id=%s %s', k.key_prefix, k.kind, coalesce(k.model_id::text,'NULL'),
             case when k.model_id is null then '<<< WRONG, key is not bound to a model' else '' end);
  end loop;
  select count(*) into n from collective.api_keys where creator_id = c.id and status = 'active';
  if n = 0 then return query select '4 active key'::text, 'NONE, stopping'::text; return; end if;

  -- 5. Rebuild the exact key context the API sends.
  select jsonb_build_object(
    'key_id', ak.id, 'kind', ak.kind,
    'creator_id', cr.id, 'creator_slug', cr.slug, 'creator_name', cr.display_name,
    'model_id', mo.id, 'model_slug', mo.slug, 'model_name', mo.name, 'sport', mo.sport_code)
  into kctx
  from collective.api_keys ak
  join collective.creators cr on cr.id = ak.creator_id
  join collective.models mo on mo.id = ak.model_id
  where cr.id = c.id and ak.status = 'active'
  order by ak.created_at desc limit 1;
  if kctx is null then
    return query select '5 key context'::text, 'NULL, the active key has no model bound. Stopping.'::text;
    return;
  end if;
  return query select '5 key context'::text, format('model=%s sport=%s', kctx->>'model_slug', kctx->>'sport');

  -- 6. A real future game for that sport.
  select gm.id as gid, gm.season as se, gm.week as wk, gm.kickoff_at as ko,
         ht.name as home, at2.name as away
  into g
  from collective.games gm
  join collective.teams ht on ht.id = gm.home_team_id
  join collective.teams at2 on at2.id = gm.away_team_id
  where gm.sport_code = kctx->>'sport' and gm.kickoff_at > now()
  order by gm.kickoff_at limit 1;
  if not found then
    return query select '6 test game'::text,
      format('no future %s game loaded, load the slate first', kctx->>'sport');
    return;
  end if;
  return query select '6 test game'::text, format('%s at %s (season %s week %s)', g.away, g.home, g.se, g.wk);

  env := jsonb_build_object(
    'sport', kctx->>'sport', 'season', g.se, 'week', g.wk, 'data_origin', 'live',
    'idempotency_key', 'diagnostic-' || clock_timestamp()::text,
    'rows', jsonb_build_array(jsonb_build_object(
      'game_ref', 'DIAGNOSTIC_ROW', 'home_team', g.home, 'away_team', g.away,
      'kickoff', to_char(g.ko at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'projected_spread', -3.5, 'pick_side', 'home')));

  -- 7. Dry run.
  begin
    r := collective.ingest_submission(kctx, env, true);
    return query select '7 dry run'::text, format('ok %s', r->'counts');
  exception when others then
    return query select '7 dry run'::text, format('FAILED %s %s', SQLSTATE, SQLERRM);
  end;

  -- 8. The real call. Deliberately rolled back: the insert runs inside this
  -- sub-block, then a sentinel error unwinds it, so the diagnostic can still
  -- return its results.
  begin
    r := collective.ingest_submission(kctx, env, false);
    raise exception 'DIAGNOSTIC_ROLLBACK';
  exception when others then
    if SQLERRM = 'DIAGNOSTIC_ROLLBACK' then
      ok_live := true;
    else
      live_state := SQLSTATE; live_msg := SQLERRM;
    end if;
  end;

  if ok_live then
    return query select '8 LIVE'::text, 'ok, ingest works at the database level'::text;
    return query select '8 meaning'::text,
      'If the API still returns 500, the cause is above the database: redeploy the functions, or check the Edge Function logs.'::text;
  else
    return query select '8 LIVE'::text, format('*** FAILED *** SQLSTATE=%s', live_state);
    return query select '8 message'::text, live_msg;
    return query select '8 meaning'::text, 'This is the real cause of the 500. Send this row back.'::text;
  end if;

  return query select '9 done'::text, 'nothing was saved'::text;
end $fn$;

select * from collective.diagnose_ingest('mustbemoose');
