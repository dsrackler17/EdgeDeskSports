-- ===========================================================================
-- EdgeDesk UFC — supabase/ufc_live_center.sql, attacked on a real PostgreSQL.
--
-- What must be true, proved rather than reasoned about:
--   * anon and authenticated can READ every research table and the status
--     view, and cannot write a single row anywhere in the contract;
--   * live_locks cannot even be read by a client role;
--   * the lock is one statement: a second owner is refused while the first
--     is live, takes over once the TTL lapses, and release is owner-checked;
--   * the same snapshot content twice is one row; the same capture twice is
--     one row; a cancelled or stale state is admitted and a nonsense one is
--     not; deleting an event takes its bouts, states and snapshots with it.
-- ===========================================================================
\set ON_ERROR_STOP on
set client_min_messages = notice;

create or replace function pg_temp.ok(p_name text, p_cond boolean, p_detail text default null)
returns void language plpgsql as $$
begin
  if p_cond then raise notice 'ok   %', p_name;
  else raise exception 'FAIL: % %', p_name, coalesce('— ' || p_detail, '');
  end if;
end; $$;
create or replace function pg_temp.as_anon() returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', '', false); execute 'set local role anon'; end; $$;
create or replace function pg_temp.as_user() returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', false); execute 'set local role authenticated'; end; $$;
create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', '', false); execute 'set local role service_role'; end; $$;
create or replace function pg_temp.as_owner() returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', '', false); execute 'reset role'; end; $$;

do $test$
declare
  n integer; failed boolean; j jsonb; t text;
begin
  -- ── seed, as the service role (the only writer the jobs use) ─────────────
  perform pg_temp.as_service();
  insert into ufc.events(event_id, provider_event_id, name, scheduled_at, event_state)
    values ('espn:1', '1', 'UFC Test Night', now() + interval '1 day', 'scheduled');
  insert into ufc.bouts(bout_id, event_id, provider_bout_id, bout_order, red_name, blue_name, status)
    values ('espn:11', 'espn:1', '11', 1, 'Red Tester', 'Blue Tester', 'scheduled');
  perform pg_temp.ok('service role can write events and bouts', true);

  -- ── 1. clients read, clients never write ────────────────────────────────
  perform pg_temp.as_anon();
  select count(*) into n from ufc.events;
  perform pg_temp.ok('anon reads events', n = 1);
  select count(*) into n from ufc.bouts;
  perform pg_temp.ok('anon reads bouts', n = 1);
  select count(*) into n from ufc.pipeline_status;
  perform pg_temp.ok('anon reads the pipeline_status view', n = 0);
  failed := false;
  begin
    insert into ufc.events(event_id, provider_event_id, name) values ('espn:2', '2', 'forged');
  exception when others then failed := true; end;
  perform pg_temp.ok('anon cannot insert an event', failed);
  failed := false;
  begin
    update ufc.bouts set status = 'final', winner_corner = 'red' where bout_id = 'espn:11';
    get diagnostics n = row_count;
    failed := (n = 0);
  exception when others then failed := true; end;
  perform pg_temp.ok('anon cannot update a bout', failed);
  failed := false;
  begin
    insert into ufc.fight_live_state(bout_id, event_id, corner, sig_strikes_landed) values ('espn:11', 'espn:1', 'red', 99);
  exception when others then failed := true; end;
  perform pg_temp.ok('anon cannot write live state', failed);
  failed := false;
  begin
    insert into ufc.market_captures(bout_id, event_id, sig_key, corner, capture_at, market_state, best_dec)
      values ('espn:11', 'espn:1', 'k', 'red', now(), 'PRE', 1.9);
  exception when others then failed := true; end;
  perform pg_temp.ok('anon cannot write a market capture', failed);
  failed := false;
  begin
    perform count(*) from ufc.live_locks;
  exception when others then failed := true; end;
  perform pg_temp.ok('anon cannot read live_locks', failed);
  failed := false;
  begin
    perform ufc.acquire_live_lock('espn:1', 'anon', 60);
  exception when others then failed := true; end;
  perform pg_temp.ok('anon cannot call acquire_live_lock', failed);

  perform pg_temp.as_user();
  select count(*) into n from ufc.bouts;
  perform pg_temp.ok('authenticated reads bouts', n = 1);
  failed := false;
  begin
    delete from ufc.bouts where bout_id = 'espn:11';
    get diagnostics n = row_count;
    failed := (n = 0);
  exception when others then failed := true; end;
  perform pg_temp.ok('authenticated cannot delete a bout', failed);
  failed := false;
  begin
    insert into ufc.fighter_baselines(fighter_id, full_name) values ('x', 'Forged Baseline');
  exception when others then failed := true; end;
  perform pg_temp.ok('authenticated cannot write a baseline', failed);
  failed := false;
  begin
    perform ufc.release_live_lock('espn:1', 'anyone');
  exception when others then failed := true; end;
  perform pg_temp.ok('authenticated cannot call release_live_lock', failed);

  -- ── 2. the lock ──────────────────────────────────────────────────────────
  perform pg_temp.as_service();
  j := ufc.acquire_live_lock('espn:1', 'run-A', 60);
  perform pg_temp.ok('first owner acquires the lock', (j->>'acquired')::boolean, j::text);
  j := ufc.acquire_live_lock('espn:1', 'run-B', 60);
  perform pg_temp.ok('second owner is refused while the first is live', not (j->>'acquired')::boolean and j->>'owner' = 'run-A', j::text);
  j := ufc.acquire_live_lock('espn:1', 'run-A', 60);
  perform pg_temp.ok('the holder can re-acquire (heartbeat)', (j->>'acquired')::boolean, j::text);
  perform pg_temp.ok('release by a non-owner is refused', not ufc.release_live_lock('espn:1', 'run-B'));
  update ufc.live_locks set expires_at = now() - interval '1 second' where event_id = 'espn:1';
  j := ufc.acquire_live_lock('espn:1', 'run-B', 60);
  perform pg_temp.ok('an expired lock is taken over', (j->>'acquired')::boolean and j->>'owner' = 'run-B', j::text);
  perform pg_temp.ok('release by the owner succeeds', ufc.release_live_lock('espn:1', 'run-B'));
  select count(*) into n from ufc.live_locks where event_id = 'espn:1';
  perform pg_temp.ok('released lock is gone', n = 0);
  j := ufc.acquire_live_lock(null, 'run-C', 60);
  perform pg_temp.ok('a lock without an event is refused', not (j->>'acquired')::boolean);

  -- ── 3. idempotent writes ─────────────────────────────────────────────────
  insert into ufc.fight_snapshots(bout_id, corner, round, sig_strikes_landed, content_hash) values ('espn:11', 'red', 1, 10, 'h1');
  insert into ufc.fight_snapshots(bout_id, corner, round, sig_strikes_landed, content_hash) values ('espn:11', 'red', 1, 10, 'h1')
    on conflict (bout_id, corner, content_hash) do nothing;
  select count(*) into n from ufc.fight_snapshots where bout_id = 'espn:11';
  perform pg_temp.ok('the same snapshot content twice is one row', n = 1);
  insert into ufc.market_captures(bout_id, event_id, sig_key, corner, capture_at, market_state, best_dec)
    values ('espn:11', 'espn:1', 'k1', 'red', '2026-01-01T00:00:00Z', 'PRE', 1.9);
  insert into ufc.market_captures(bout_id, event_id, sig_key, corner, capture_at, market_state, best_dec)
    values ('espn:11', 'espn:1', 'k1', 'red', '2026-01-01T00:00:00Z', 'PRE', 1.9)
    on conflict (sig_key, capture_at) do nothing;
  select count(*) into n from ufc.market_captures where sig_key = 'k1';
  perform pg_temp.ok('the same capture twice is one row', n = 1);
  failed := false;
  begin
    insert into ufc.market_captures(bout_id, event_id, sig_key, corner, capture_at, market_state, best_dec)
      values ('espn:11', 'espn:1', 'k2', 'red', now(), 'CLOSE', 1.9);
  exception when others then failed := true; end;
  perform pg_temp.ok('a capture must be PRE or LIVE', failed);
  failed := false;
  begin
    insert into ufc.market_captures(bout_id, event_id, sig_key, corner, capture_at, market_state, best_dec)
      values ('espn:11', 'espn:1', 'k3', 'fighter', now(), 'PRE', 1.9);
  exception when others then failed := true; end;
  perform pg_temp.ok('a capture corner is red, blue or draw', failed);
  insert into ufc.market_rejections(signal_event_id, sig_key, reason, home_team, away_team) values ('odds9', '', 'draw_as_fighter', 'Draw', 'Somebody');
  insert into ufc.market_rejections(signal_event_id, sig_key, reason, home_team, away_team, seen_count) values ('odds9', '', 'draw_as_fighter', 'Draw', 'Somebody', 2)
    on conflict (signal_event_id, sig_key, reason) do update set seen_count = excluded.seen_count, last_seen_at = now();
  select seen_count into n from ufc.market_rejections where signal_event_id = 'odds9';
  perform pg_temp.ok('a repeated rejection updates in place', n = 2);

  -- ── 4. state shapes ──────────────────────────────────────────────────────
  update ufc.bouts set status = 'cancelled', status_detail = 'absent from provider card' where bout_id = 'espn:11';
  perform pg_temp.ok('a bout can be cancelled', true);
  update ufc.events set event_state = 'stale' where event_id = 'espn:1';
  perform pg_temp.ok('an event can be marked stale', true);
  failed := false;
  begin
    update ufc.events set event_state = 'happening' where event_id = 'espn:1';
  exception when others then failed := true; end;
  perform pg_temp.ok('an unknown event state is refused', failed);
  failed := false;
  begin
    update ufc.bouts set winner_corner = 'Draw' where bout_id = 'espn:11';
  exception when others then failed := true; end;
  perform pg_temp.ok('a winner corner outside red/blue/draw/nc is refused', failed);
  select updated_at > now() - interval '1 minute' into failed from ufc.bouts where bout_id = 'espn:11';
  perform pg_temp.ok('updated_at is kept by the database', failed);

  -- ── 5. the status view ───────────────────────────────────────────────────
  insert into ufc.pipeline_runs(run_id, job, status, started_at, heartbeat_at) values ('r1', 'ufc_live', 'ok', now() - interval '2 hours', now() - interval '2 hours');
  insert into ufc.pipeline_runs(run_id, job, status, started_at, heartbeat_at, event_id) values ('r2', 'ufc_live', 'running', now() - interval '1 minute', now() - interval '20 seconds', 'espn:1');
  insert into ufc.pipeline_runs(run_id, job, status, started_at, heartbeat_at) values ('r3', 'ufc_sync', 'ok', now() - interval '3 hours', now() - interval '3 hours');
  select count(*) into n from ufc.pipeline_status;
  perform pg_temp.ok('pipeline_status is one row per job', n = 2);
  select run_id into t from ufc.pipeline_status where job = 'ufc_live';
  perform pg_temp.ok('pipeline_status shows the latest run per job', t = 'r2', t);
  select seconds_since_heartbeat into n from ufc.pipeline_status where job = 'ufc_live';
  perform pg_temp.ok('seconds_since_heartbeat is measured', n between 15 and 90, n::text);
  perform pg_temp.as_anon();
  select run_id into t from ufc.pipeline_status where job = 'ufc_live';
  perform pg_temp.ok('anon reads the latest run through the view', t = 'r2');

  -- ── 6. cascade ───────────────────────────────────────────────────────────
  perform pg_temp.as_service();
  delete from ufc.events where event_id = 'espn:1';
  select count(*) into n from ufc.bouts where event_id = 'espn:1';
  perform pg_temp.ok('deleting an event removes its bouts', n = 0);
  select count(*) into n from ufc.fight_snapshots where bout_id = 'espn:11';
  perform pg_temp.ok('and their snapshots', n = 0);
  select count(*) into n from ufc.market_captures where bout_id = 'espn:11';
  perform pg_temp.ok('and their captures', n = 0);
  perform pg_temp.as_owner();
end $test$;
