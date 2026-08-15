-- ============================================================================
--  supabase/tests/ufc_live_v2_constraints.sql
--  Database-level guarantees for the UFC live layer.
--  RUN:  psql -f supabase/tests/ufc_live_v2_constraints.sql
--  Requires sql/ufc_live_v2.sql to have been applied first.
--
--  These are the cases the JavaScript suites cannot cover, because the
--  guarantee lives in the schema rather than in the poller: if the poller is
--  ever rewritten, these constraints still hold.
-- ============================================================================
\set ON_ERROR_STOP on
begin;

-- 1. DUPLICATE FIGHT: a bout upserted twice is one row, updated, not two.
insert into ufc.live_fight_state (fight_id,event_id,status,round) values ('dup1','e1','in',1)
  on conflict (fight_id) do update set status=excluded.status, round=excluded.round;
insert into ufc.live_fight_state (fight_id,event_id,status,round) values ('dup1','e1','post',3)
  on conflict (fight_id) do update set status=excluded.status, round=excluded.round;
do $$ declare n int; st text; begin
  select count(*), max(status) into n, st from ufc.live_fight_state where fight_id='dup1';
  assert n=1, 'duplicate fight created '||n||' rows';
  assert st='post', 'the second write did not update the row';
  raise notice 'PASS  duplicate fight upserts to one updated row';
end $$;

-- 2. DUPLICATE ROUND STATS: same (fight,corner,round) upserts, never duplicates.
insert into ufc.live_fight_round_stats (fight_id,corner,round,sig_strikes_landed)
  values ('dup1','red',1,10)
  on conflict (fight_id,corner,round) do update set sig_strikes_landed=excluded.sig_strikes_landed;
insert into ufc.live_fight_round_stats (fight_id,corner,round,sig_strikes_landed)
  values ('dup1','red',1,24)
  on conflict (fight_id,corner,round) do update set sig_strikes_landed=excluded.sig_strikes_landed;
do $$ declare n int; v int; begin
  select count(*), max(sig_strikes_landed) into n, v
    from ufc.live_fight_round_stats where fight_id='dup1' and corner='red' and round=1;
  assert n=1, 'duplicate round stats created '||n||' rows';
  assert v=24, 'the live count did not advance';
  raise notice 'PASS  duplicate round stats upsert to one advancing row';
end $$;

-- 3. Both corners and every round coexist for one fight.
insert into ufc.live_fight_round_stats (fight_id,corner,round,sig_strikes_landed) values
  ('dup1','blue',1,18), ('dup1','red',2,9), ('dup1','red',0,33)
  on conflict (fight_id,corner,round) do nothing;
do $$ declare n int; begin
  select count(*) into n from ufc.live_fight_round_stats where fight_id='dup1';
  assert n=4, 'expected 4 distinct (corner,round) rows, got '||n;
  raise notice 'PASS  corners and rounds coexist (round 0 = fight total)';
end $$;

-- 4. DUPLICATE SNAPSHOT: identical content is rejected; changed content is kept.
insert into ufc.live_fight_snapshots (fight_id,corner,round,sig_strikes_landed,content_hash)
  values ('dup1','red',1,10,'H1') on conflict do nothing;
insert into ufc.live_fight_snapshots (fight_id,corner,round,sig_strikes_landed,content_hash)
  values ('dup1','red',1,10,'H1') on conflict do nothing;
insert into ufc.live_fight_snapshots (fight_id,corner,round,sig_strikes_landed,content_hash)
  values ('dup1','red',1,24,'H2') on conflict do nothing;
do $$ declare n int; begin
  select count(*) into n from ufc.live_fight_snapshots where fight_id='dup1';
  assert n=2, 'snapshot dedup failed: expected 2 rows, got '||n;
  raise notice 'PASS  identical snapshot skipped, changed snapshot stored';
end $$;

-- 5. A NULL statistic stays NULL. The schema must never default it to zero.
insert into ufc.live_fight_round_stats (fight_id,corner,round,sig_strikes_landed)
  values ('nulltest','red',1,5) on conflict do nothing;
do $$ declare k int; c int; begin
  select knockdowns, control_seconds into k, c
    from ufc.live_fight_round_stats where fight_id='nulltest';
  assert k is null, 'knockdowns defaulted to '||k||' — an unpublished stat must stay NULL';
  assert c is null, 'control_seconds defaulted — an unpublished stat must stay NULL';
  raise notice 'PASS  unpublished statistics stay NULL, never 0';
end $$;

-- 6. MALFORMED WRITES are rejected by the schema, not silently stored.
do $$ begin
  begin
    insert into ufc.live_fight_round_stats (fight_id,corner,round) values ('bad','purple',1);
    assert false, 'a nonsense corner was accepted';
  exception when check_violation then raise notice 'PASS  bad corner rejected'; end;
  begin
    insert into ufc.live_fight_round_stats (fight_id,corner,round) values ('bad','red',99);
    assert false, 'an impossible round was accepted';
  exception when check_violation then raise notice 'PASS  impossible round rejected'; end;
  begin
    insert into ufc.live_fight_state (event_id) values ('e1');
    assert false, 'a bout with no fight_id was accepted';
  exception when not_null_violation then raise notice 'PASS  fight_id required'; end;
end $$;

-- 7. The health view answers with no runs recorded (a fresh install must not error).
do $$ declare n int; begin
  select count(*) into n from ufc.live_pipeline_health;
  raise notice 'PASS  health view queryable (% row(s))', n;
end $$;

-- 8. Telemetry accepts a failed run — a broken capture must still be recordable.
insert into ufc.live_capture_runs (build,mode,ok,status,provider,provider_verified,
  api_failures,http_status_counts,db_write_failures,write_errors,error)
  values ('test','active',false,'failed','sportradar',false,3,
          '{"500":3}'::jsonb,2,'["snapshot: timeout"]'::jsonb,'provider discovery threw');
do $$ declare n int; begin
  select count(*) into n from ufc.live_capture_runs where status='failed';
  assert n=1, 'a failed run could not be recorded';
  raise notice 'PASS  a failed run is recordable (db write failure is observable)';
end $$;

rollback;
\echo '--- all constraint tests passed (rolled back) ---'
