-- ===========================================================================
-- EdgeDesk Tennis — supabase/tennis_live_center.sql, attacked on a real
-- PostgreSQL.
--
-- What must be true, proved rather than reasoned about:
--   * anon and authenticated can READ every research table and the status
--     view, and cannot write a single row anywhere in the contract;
--   * live_locks cannot even be read by a client role, and the lock RPCs are
--     not executable by one;
--   * the lock is one statement: a second owner is refused while the first is
--     live, takes over once the TTL lapses, and release is owner-checked. It
--     is keyed by a TOUR-DAY, so two tours on the same day do not collide;
--   * the same snapshot content twice is one row; the same capture twice is
--     one row; a market state outside PRE/LIVE is refused, as is a side
--     outside home/away and a close bound the pipeline cannot justify;
--   * service_role can write tennis.meta (the grant a production run needed);
--   * deleting a tournament takes its matches, states, sets and snapshots.
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
begin perform set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', false); execute 'set local role authenticated'; end; $$;
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
  insert into tennis.tournaments(tournament_id, provider_tournament_id, tour, name, surface, start_date, state)
    values ('espn:7000001', '7000001', 'ATP', 'Testville Open', 'clay', current_date, 'scheduled');
  insert into tennis.live_matches(match_id, tournament_id, provider_match_id, tour, round, match_order,
                                  home_name, away_name, best_of, scheduled_at, status)
    values ('espn:8000001', 'espn:7000001', '8000001', 'ATP', 'Round of 32', 1,
            'Marco Testerson', 'Ivan Placeholder', 5, now() + interval '2 hours', 'scheduled');
  insert into tennis.live_matches(match_id, tournament_id, provider_match_id, tour, round, match_order,
                                  home_name, away_name, is_doubles, best_of, status)
    values ('espn:8000004', 'espn:7000001', '8000004', 'ATP', 'Round of 16', 2,
            'Rohan Testpair/Matt Fixtureman', 'Marcel Sampleton/Horacio Placeholder', true, 3, 'scheduled');
  perform pg_temp.ok('service role can write tournaments and matches', true);

  -- the grant a production UFC run discovered it was missing; tennis has it
  insert into tennis.meta(key, value) values ('tennis_sync_last_status', 'ok')
    on conflict (key) do update set value = excluded.value;
  perform pg_temp.ok('service role can write tennis.meta', (select value from tennis.meta where key = 'tennis_sync_last_status') = 'ok');

  -- ── 1. clients read, clients never write ────────────────────────────────
  perform pg_temp.as_anon();
  select count(*) into n from tennis.tournaments;
  perform pg_temp.ok('anon reads tournaments', n = 1);
  select count(*) into n from tennis.live_matches;
  perform pg_temp.ok('anon reads live_matches', n = 2);
  select count(*) into n from tennis.pipeline_status;
  perform pg_temp.ok('anon reads the pipeline_status view', n = 0);
  select count(*) into n from tennis.meta;
  perform pg_temp.ok('anon reads the meta ledger', n = 1);

  failed := false;
  begin insert into tennis.tournaments(tournament_id, provider_tournament_id, tour, name) values ('espn:9', '9', 'ATP', 'forged');
  exception when others then failed := true; end;
  perform pg_temp.ok('anon cannot insert a tournament', failed);

  failed := false;
  begin update tennis.live_matches set status = 'final', winner_side = 'home' where match_id = 'espn:8000001';
  exception when others then failed := true; end;
  perform pg_temp.ok('anon cannot rewrite a result', failed);

  failed := false;
  begin delete from tennis.live_matches where match_id = 'espn:8000001';
  exception when others then failed := true; end;
  perform pg_temp.ok('anon cannot delete a match', failed);

  failed := false;
  begin insert into tennis.market_captures(match_id, tournament_id, sig_key, side, capture_at, market_state)
        values ('espn:8000001', 'espn:7000001', 'forged', 'home', now(), 'PRE');
  exception when others then failed := true; end;
  perform pg_temp.ok('anon cannot forge a market capture', failed);

  failed := false;
  begin insert into tennis.player_baselines(player_id, full_name, obs_matches) values ('p9', 'forged', 99);
  exception when others then failed := true; end;
  perform pg_temp.ok('anon cannot forge a baseline', failed);

  failed := false;
  begin insert into tennis.pipeline_runs(run_id, job, status) values ('forged', 'tennis_live', 'ok');
  exception when others then failed := true; end;
  perform pg_temp.ok('anon cannot forge a pipeline run', failed);

  perform pg_temp.as_user();
  select count(*) into n from tennis.live_matches;
  perform pg_temp.ok('an authenticated reader reads matches', n = 2);
  failed := false;
  begin update tennis.tournaments set state = 'live' where tournament_id = 'espn:7000001';
  exception when others then failed := true; end;
  perform pg_temp.ok('an authenticated reader cannot write a tournament', failed);

  -- ── 2. the lock table is not client-visible at all ──────────────────────
  perform pg_temp.as_anon();
  failed := false;
  begin select count(*) into n from tennis.live_locks;
  exception when others then failed := true; end;
  perform pg_temp.ok('anon cannot even read live_locks', failed);

  failed := false;
  begin perform tennis.acquire_live_lock('atp:2026-05-28', 'anon-thief', 60);
  exception when others then failed := true; end;
  perform pg_temp.ok('anon cannot call acquire_live_lock', failed);

  failed := false;
  begin perform tennis.release_live_lock('atp:2026-05-28', 'anon-thief');
  exception when others then failed := true; end;
  perform pg_temp.ok('anon cannot call release_live_lock', failed);

  -- ── 3. the tour-day lock's race semantics ───────────────────────────────
  perform pg_temp.as_service();
  j := tennis.acquire_live_lock('atp:2026-05-28', 'runner-a', 60);
  perform pg_temp.ok('the first poller takes the lock', (j->>'acquired')::boolean);

  j := tennis.acquire_live_lock('atp:2026-05-28', 'runner-b', 60);
  perform pg_temp.ok('a second poller is refused while the first holds it', not (j->>'acquired')::boolean);
  perform pg_temp.ok('the refusal names the holder', j->>'owner' = 'runner-a', j::text);

  j := tennis.acquire_live_lock('atp:2026-05-28', 'runner-a', 60);
  perform pg_temp.ok('the holder renews its own lock', (j->>'acquired')::boolean);

  -- a different tour on the same day is a different key and must not collide
  j := tennis.acquire_live_lock('wta:2026-05-28', 'runner-c', 60);
  perform pg_temp.ok('the other tour on the same day takes its own lock', (j->>'acquired')::boolean);
  select count(*) into n from tennis.live_locks;
  perform pg_temp.ok('two tour-days hold two locks', n = 2);

  -- the TTL, not a heartbeat, is what frees a dead poller
  update tennis.live_locks set expires_at = now() - interval '1 second' where lock_key = 'atp:2026-05-28';
  j := tennis.acquire_live_lock('atp:2026-05-28', 'runner-b', 60);
  perform pg_temp.ok('a lapsed lock is taken over', (j->>'acquired')::boolean and j->>'owner' = 'runner-b');

  perform pg_temp.ok('release by the wrong owner does nothing', tennis.release_live_lock('atp:2026-05-28', 'runner-a') = false);
  perform pg_temp.ok('release by the owner works', tennis.release_live_lock('atp:2026-05-28', 'runner-b') = true);
  select count(*) into n from tennis.live_locks where lock_key = 'atp:2026-05-28';
  perform pg_temp.ok('the released lock is gone', n = 0);

  j := tennis.acquire_live_lock(null, 'runner-a', 60);
  perform pg_temp.ok('a null lock key is refused, not crashed on', not (j->>'acquired')::boolean);

  -- ── 4. the shapes the pipeline depends on ───────────────────────────────
  failed := false;
  begin update tennis.live_matches set status = 'in_progress' where match_id = 'espn:8000001';
  exception when others then failed := true; end;
  perform pg_temp.ok('a status outside the contract is refused', failed);

  failed := false;
  begin update tennis.live_matches set server_side = 'blue' where match_id = 'espn:8000001';
  exception when others then failed := true; end;
  perform pg_temp.ok('a serving side outside home/away is refused', failed);

  failed := false;
  begin update tennis.live_matches set close_bound_source = 'guessed' where match_id = 'espn:8000001';
  exception when others then failed := true; end;
  perform pg_temp.ok('a close bound the pipeline cannot justify is refused', failed);

  update tennis.live_matches set close_bound_source = 'observed_first_point', first_point_at = now() where match_id = 'espn:8000001';
  perform pg_temp.ok('the observed first point is accepted', true);

  failed := false;
  begin insert into tennis.market_captures(match_id, tournament_id, sig_key, side, capture_at, market_state)
        values ('espn:8000001', 'espn:7000001', 'k1', 'home', now(), 'CLOSE');
  exception when others then failed := true; end;
  perform pg_temp.ok('a market state outside PRE/LIVE is refused', failed);

  failed := false;
  begin insert into tennis.match_live_state(match_id, tournament_id, side) values ('espn:8000001', 'espn:7000001', 'red');
  exception when others then failed := true; end;
  perform pg_temp.ok('a corner name from another sport is refused as a side', failed);

  failed := false;
  begin insert into tennis.match_set_stats(match_id, tournament_id, set_number, side) values ('espn:8000001', 'espn:7000001', 0, 'home');
  exception when others then failed := true; end;
  perform pg_temp.ok('set zero is refused', failed);

  failed := false;
  begin insert into tennis.match_set_stats(match_id, tournament_id, set_number, side, stat_source)
        values ('espn:8000001', 'espn:7000001', 1, 'home', 'guessed');
  exception when others then failed := true; end;
  perform pg_temp.ok('a stat source outside provider/snapshot_delta is refused', failed);

  -- the wide confidence check the production alias write needed
  insert into tennis.player_aliases(alias_key, player_id, confidence) values ('espn:9000001', 'p1', 'initial_last');
  perform pg_temp.ok('an initial_last alias is accepted', true);
  insert into tennis.player_aliases(alias_key, player_id, confidence) values ('name:marco testerson', 'p1', 'surname');
  perform pg_temp.ok('a surname alias is accepted', true);
  failed := false;
  begin insert into tennis.player_aliases(alias_key, player_id, confidence) values ('name:x', 'p1', 'vibes');
  exception when others then failed := true; end;
  perform pg_temp.ok('an alias confidence the resolver never produces is refused', failed);

  -- ── 5. idempotency: the same thing twice is one row ─────────────────────
  insert into tennis.match_snapshots(match_id, side, status, current_set, content_hash)
    values ('espn:8000001', 'home', 'live', 1, 'hash-a');
  failed := false;
  begin insert into tennis.match_snapshots(match_id, side, status, current_set, content_hash)
        values ('espn:8000001', 'home', 'live', 1, 'hash-a');
  exception when unique_violation then failed := true; end;
  perform pg_temp.ok('the same snapshot content twice is refused as a duplicate', failed);

  insert into tennis.match_snapshots(match_id, side, status, current_set, content_hash)
    values ('espn:8000001', 'away', 'live', 1, 'hash-a');
  perform pg_temp.ok('the other side may carry the same hash', true);

  insert into tennis.market_captures(match_id, tournament_id, sig_key, side, capture_at, market_state, best_dec)
    values ('espn:8000001', 'espn:7000001', 'k1', 'home', timestamptz '2026-05-28 10:55:00Z', 'PRE', 1.55);
  failed := false;
  begin insert into tennis.market_captures(match_id, tournament_id, sig_key, side, capture_at, market_state, best_dec)
        values ('espn:8000001', 'espn:7000001', 'k1', 'home', timestamptz '2026-05-28 10:55:00Z', 'PRE', 1.55);
  exception when unique_violation then failed := true; end;
  perform pg_temp.ok('the same capture twice is refused as a duplicate', failed);

  insert into tennis.market_rejections(signal_event_id, sig_key, reason) values ('ev1', '', 'one_side_unresolved');
  failed := false;
  begin insert into tennis.market_rejections(signal_event_id, sig_key, reason) values ('ev1', '', 'one_side_unresolved');
  exception when unique_violation then failed := true; end;
  perform pg_temp.ok('a rejection is keyed so it is counted, not duplicated', failed);

  -- one fixture links to at most one match
  insert into tennis.match_markets(match_id, tournament_id, signal_event_id, sport_key, link_method)
    values ('espn:8000001', 'espn:7000001', 'sig-ev-1', 'tennis_atp', 'both_names_exact');
  failed := false;
  begin insert into tennis.match_markets(match_id, tournament_id, signal_event_id, sport_key, link_method)
        values ('espn:8000004', 'espn:7000001', 'sig-ev-1', 'tennis_atp', 'both_names_exact');
  exception when unique_violation then failed := true; end;
  perform pg_temp.ok('one odds fixture cannot be linked to two matches', failed);

  failed := false;
  begin insert into tennis.match_markets(match_id, tournament_id, signal_event_id, sport_key, link_method)
        values ('espn:8000004', 'espn:7000001', 'sig-ev-2', 'tennis_atp', 'best_guess');
  exception when others then failed := true; end;
  perform pg_temp.ok('a link method that is not a proven match is refused', failed);

  -- ── 6. the pipeline ledger and its view ─────────────────────────────────
  insert into tennis.pipeline_runs(run_id, job, scope, status, message)
    values ('run-1', 'tennis_live', 'atp:2026-05-28', 'running', 'polling');
  insert into tennis.pipeline_runs(run_id, job, scope, status, started_at, message)
    values ('run-0', 'tennis_live', 'atp:2026-05-27', 'ok', now() - interval '1 day', 'yesterday');
  select count(*) into n from tennis.pipeline_status where job = 'tennis_live';
  perform pg_temp.ok('pipeline_status keeps one row per job', n = 1);
  select run_id into t from tennis.pipeline_status where job = 'tennis_live';
  perform pg_temp.ok('pipeline_status keeps the newest run', t = 'run-1', t);

  failed := false;
  begin insert into tennis.pipeline_runs(run_id, job, status) values ('run-2', 'tennis_live', 'vibing');
  exception when others then failed := true; end;
  perform pg_temp.ok('a run status outside the contract is refused', failed);

  -- ── 7. the cascade ──────────────────────────────────────────────────────
  delete from tennis.tournaments where tournament_id = 'espn:7000001';
  select count(*) into n from tennis.live_matches;
  perform pg_temp.ok('deleting a tournament takes its matches', n = 0);
  select count(*) into n from tennis.match_snapshots;
  perform pg_temp.ok('deleting a tournament takes its snapshots', n = 0);
  select count(*) into n from tennis.market_captures;
  perform pg_temp.ok('deleting a tournament takes its captures', n = 0);
  select count(*) into n from tennis.match_markets;
  perform pg_temp.ok('deleting a tournament takes its market links', n = 0);

  -- ── 8. the licensed record is not touched by any of this ────────────────
  perform pg_temp.as_owner();
  select count(*) into n from information_schema.tables
   where table_schema = 'tennis' and table_name in ('players', 'matches', 'rankings_current');
  perform pg_temp.ok('the migration creates no table named like the licensed record', n = 0);

  raise notice 'all tennis live center SQL assertions passed';
end
$test$;
