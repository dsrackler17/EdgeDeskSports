-- tennis_record -- part 8 of 9.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- ===========================================================================
-- ROW LEVEL SECURITY, GRANTS, AND THE DOOR EACH TABLE HAS.
--
-- Four postures, and every table below is in exactly one of them:
--
--   PRIVATE      staging, point-in-time features, ingestion runs, data-quality
--                issues. RLS on, NO grant to any client role. Not readable by
--                a browser under any session, entitled or not. These are the
--                model's training inputs and the pipeline's own diary.
--   PUBLIC       the record: players, matches, tournaments, rankings, ratings,
--                venues, weather, licences. Readable by anyone, writable by
--                nobody but the service role.
--   SUBSCRIBER   predictions, odds snapshots, research opportunities. Readable
--                only by a signed-in account that public.community_is_entitled
--                says is entitled.
--   RECORD       tennis.prediction_record — public once the match has started
--                or settled, subscriber-only before then. Exactly the boundary
--                public.public_brief_closes already draws: the live board is
--                the paywall, the history is not.
--
-- No client role gets INSERT, UPDATE or DELETE on anything. The pipeline writes
-- as service_role, which bypasses RLS, and that is the only write door.
-- Only tables THIS file creates are touched: the live contract's own tables and
-- policies are left exactly as they are.
-- ===========================================================================

-- ---- PRIVATE ---------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['stg_archive_matches','player_match_features',
                           'ingestion_runs','data_quality_issues'] loop
    execute format('alter table tennis.%I enable row level security', t);
    execute format('revoke all on tennis.%I from anon, authenticated', t);
    execute format('grant all on tennis.%I to service_role', t);
    -- no policy: RLS with no policy denies every row to every non-bypassing role
    execute format('drop policy if exists %I on tennis.%I', 'tennis_' || t || '_public_read', t);
  end loop;
end $$;

-- ---- PUBLIC ----------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['players','matches','venues','weather_observations',
                           'rankings_current','player_ratings_current','source_licenses',
                           'model_registry'] loop
    execute format('alter table tennis.%I enable row level security', t);
    execute format('revoke insert, update, delete, truncate, references, trigger on tennis.%I from anon, authenticated', t);
    execute format('grant select on tennis.%I to anon, authenticated', t);
    execute format('grant all on tennis.%I to service_role', t);
    execute format('drop policy if exists %I on tennis.%I', 'tennis_' || t || '_public_read', t);
    execute format('create policy %I on tennis.%I for select to anon, authenticated using (true)',
                   'tennis_' || t || '_public_read', t);
  end loop;
end $$;

-- tennis.tournaments is the live contract's table. It already carries RLS, a
-- public read policy and the service-role grant; this file adds columns to it
-- and must not restate its door. The report checks the door is still there.
do $$
begin
  if to_regclass('tennis.tournaments') is not null
     and not exists (select 1 from pg_policies
                      where schemaname = 'tennis' and tablename = 'tournaments') then
    -- only when nothing has granted it yet (this file applied first)
    execute 'alter table tennis.tournaments enable row level security';
    execute 'revoke insert, update, delete, truncate, references, trigger on tennis.tournaments from anon, authenticated';
    execute 'grant select on tennis.tournaments to anon, authenticated';
    execute 'grant all on tennis.tournaments to service_role';
    execute 'create policy tennis_tournaments_public_read on tennis.tournaments for select to anon, authenticated using (true)';
  end if;
end $$;

-- ---- SUBSCRIBER ------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['model_predictions','odds_snapshots','research_opportunities'] loop
    execute format('alter table tennis.%I enable row level security', t);
    execute format('revoke all on tennis.%I from anon', t);
    execute format('revoke insert, update, delete, truncate, references, trigger on tennis.%I from authenticated', t);
    execute format('grant select on tennis.%I to authenticated', t);
    execute format('grant all on tennis.%I to service_role', t);
    execute format('drop policy if exists %I on tennis.%I', 'tennis_' || t || '_subscriber_read', t);
    execute format('create policy %I on tennis.%I for select to authenticated using (tennis.viewer_is_entitled())',
                   'tennis_' || t || '_subscriber_read', t);
  end loop;
end $$;

-- ---- THE PUBLIC RECORD -----------------------------------------------------
alter table tennis.prediction_record enable row level security;
revoke insert, update, delete, truncate, references, trigger on tennis.prediction_record from anon, authenticated;
grant select on tennis.prediction_record to anon, authenticated;
grant all on tennis.prediction_record to service_role;
drop policy if exists tennis_record_public_read on tennis.prediction_record;
-- A claim becomes public when the match it is about has started. Before then it
-- is a live research surface and follows the subscriber rule.
create policy tennis_record_public_read on tennis.prediction_record
  for select to anon, authenticated
  using (settled_at is not null
         or (scheduled_at is not null and scheduled_at <= now()));
drop policy if exists tennis_record_subscriber_read on tennis.prediction_record;
create policy tennis_record_subscriber_read on tennis.prediction_record
  for select to authenticated
  using (tennis.viewer_is_entitled());

-- ---- VIEWS -----------------------------------------------------------------
-- Every one is security_invoker, so these grants hand out no authority the
-- caller's own policies do not already give them.
grant select on tennis.player_match_rows, tennis.player_career, tennis.player_season,
                tennis.player_surface, tennis.player_form, tennis.h2h,
                tennis.player_profile, tennis.board_public, tennis.record_health,
                tennis.public_record_summary, tennis.public_record_calibration
  to anon, authenticated, service_role;
grant select on tennis.board_research, tennis.board_current, tennis.match_context to authenticated, service_role;
revoke all on tennis.board_research from anon;
revoke all on tennis.board_current from anon;
revoke all on tennis.match_context from anon;

grant usage, select on all sequences in schema tennis to service_role;

-- ===========================================================================
-- MAINTENANCE HELPERS. Used by the importer; not reachable from a browser.
-- ===========================================================================

-- Expensive secondary indexes are built AFTER a bulk backfill, not during it.
-- These two calls are what the importer brackets its COPY with.
create or replace function tennis.drop_backfill_indexes()
returns void
language plpgsql
security definer
set search_path = tennis, pg_temp
as $$
declare i text;
begin
  foreach i in array array['tennis_matches_winner_date_idx','tennis_matches_loser_date_idx',
                           'tennis_matches_surface_date_idx','tennis_matches_season_idx',
                           'tennis_matches_uid_idx','tennis_matches_tournament_idx',
                           'tennis_pmf_player_date_idx','tennis_pmf_surface_idx'] loop
    execute format('drop index if exists tennis.%I', i);
  end loop;
end $$;

create or replace function tennis.rebuild_backfill_indexes()
returns void
language plpgsql
security definer
set search_path = tennis, pg_temp
as $$
begin
  create index if not exists tennis_matches_winner_date_idx  on tennis.matches (winner_id, match_date desc);
  create index if not exists tennis_matches_loser_date_idx   on tennis.matches (loser_id, match_date desc);
  create index if not exists tennis_matches_surface_date_idx on tennis.matches (surface, match_date desc);
  create index if not exists tennis_matches_season_idx       on tennis.matches (tour, season desc, match_date desc);
  create index if not exists tennis_matches_uid_idx          on tennis.matches (source_match_uid);
  create index if not exists tennis_matches_tournament_idx   on tennis.matches (tournament_id, round_order);
  create index if not exists tennis_pmf_player_date_idx      on tennis.player_match_features (player_id, match_date desc);
  create index if not exists tennis_pmf_surface_idx          on tennis.player_match_features (surface, match_date);
  analyze tennis.matches;
  analyze tennis.player_match_features;
  analyze tennis.players;
end $$;

revoke all on function tennis.drop_backfill_indexes() from public, anon, authenticated;
revoke all on function tennis.rebuild_backfill_indexes() from public, anon, authenticated;
grant execute on function tennis.drop_backfill_indexes() to service_role;
grant execute on function tennis.rebuild_backfill_indexes() to service_role;

-- Record one data-quality issue, deduplicated. The importer calls this rather
-- than writing the table, so the dedup rule lives in one place.
create or replace function tennis.record_quality_issue(
  p_run_id uuid, p_source_key text, p_issue_type text, p_severity text,
  p_entity_type text, p_entity_key text, p_field text,
  p_observed text, p_expected text, p_detail text, p_payload jsonb default null)
returns bigint
language plpgsql
security definer
set search_path = tennis, pg_temp
as $$
declare id bigint;
begin
  insert into tennis.data_quality_issues
    (run_id, source_key, issue_type, severity, entity_type, entity_key, field,
     observed, expected, detail, payload)
  values (p_run_id, p_source_key, p_issue_type, coalesce(p_severity,'warn'),
          p_entity_type, p_entity_key, p_field, p_observed, p_expected, p_detail, p_payload)
  on conflict (issue_type, coalesce(entity_type,''), coalesce(entity_key,''), coalesce(field,''))
    where resolved_at is null
  do update set occurrences = tennis.data_quality_issues.occurrences + 1,
                last_seen_at = now(),
                run_id = excluded.run_id,
                detail = excluded.detail
  returning issue_id into id;
  return id;
end $$;
revoke all on function tennis.record_quality_issue(uuid, text, text, text, text, text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function tennis.record_quality_issue(uuid, text, text, text, text, text, text, text, text, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- The freshness stamp the Tennis panel reads. Written here so a database that
-- has the contract but no rows yet still says which contract it has.
-- ---------------------------------------------------------------------------
insert into tennis.meta (key, value)
values ('record_contract', 'tennis_record.sql')
on conflict (key) do update set value = excluded.value;

notify pgrst, 'reload schema';
