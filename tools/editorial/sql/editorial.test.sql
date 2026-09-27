-- ===========================================================================
-- supabase/editorial_system.sql, ATTACKED.
--
-- Two rules in this schema are statements about VALUES rather than about rows,
-- which means no RLS policy can express either and both live in triggers. A
-- trigger nobody attacked is a trigger nobody has checked, so:
--
--   1  A PREGAME SNAPSHOT IS IMMUTABLE, including to the service role, because
--      the pipeline runs as the service role and the whole postgame audit
--      rests on the pregame state not having moved.
--   2  ONLY A PERSON CLOSES A MODEL-REVIEW CANDIDATE, with a disposition and a
--      note, because a system that closes its own investigations is a system
--      that retunes itself on one Sunday.
--
-- Plus the RLS boundary: the research behind an UNPUBLISHED article is
-- invisible to the public, and the run log is invisible to the public
-- entirely.
--
-- Every check raises on failure, so reaching the end is the suite passing.
-- ===========================================================================

\set ON_ERROR_STOP on

create or replace function pg_temp.chk(name text, cond boolean) returns void
language plpgsql as $$
begin
  if cond then raise notice 'ok  %', name;
  else raise exception 'FAIL: %', name; end if;
end $$;

-- Two article rows: one published, one not. The published one is what makes
-- the research behind it public.
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'operator@edgedesk.test'),
  ('22222222-2222-2222-2222-222222222222', 'reader@edgedesk.test')
  on conflict (id) do nothing;
insert into public.site_article_admins (user_id, note)
  values ('11111111-1111-1111-1111-111111111111', 'the suite''s operator')
  on conflict (user_id) do nothing;

insert into public.site_articles
  (id, game_id, sport, slug, title, article, home_team, away_team, canonical_url, status, published_at)
values
  ('nfl-PUB', 'GAME_PUB', 'NFL', 'pub-slug', 'A published article', '{}'::jsonb,
   'Home', 'Away', 'https://edgedesksports.com/articles/pub-slug', 'published', now()),
  ('nfl-DRAFT', 'GAME_DRAFT', 'NFL', 'draft-slug', 'A draft article', '{}'::jsonb,
   'Home', 'Away', 'https://edgedesksports.com/articles/draft-slug', 'draft', null);

-- ---------------------------------------------------------------------------
-- 1  A SNAPSHOT CANNOT BE EDITED, AND NOT BY THE OWNER EITHER.
-- ---------------------------------------------------------------------------
insert into public.editorial_snapshots
  (snapshot_id, key, game_id, sport, captured_at, kickoff, payload, fact_count)
values ('snap_pub', 'NFL:GAME_PUB', 'GAME_PUB', 'NFL',
        now() - interval '6 hours', now() - interval '1 hour',
        '{"model":{"fair_spread_text":"Home -3.0"}}'::jsonb, 42);

do $$
begin
  begin
    update public.editorial_snapshots
      set payload = '{"model":{"fair_spread_text":"Home -9.0"}}'::jsonb
      where snapshot_id = 'snap_pub';
    raise exception 'FAIL: a snapshot payload was edited';
  exception when check_violation then
    perform pg_temp.chk('a snapshot payload cannot be edited, even as the owner', true);
  end;
end $$;

do $$
begin
  begin
    update public.editorial_snapshots set captured_at = now() where snapshot_id = 'snap_pub';
    raise exception 'FAIL: a snapshot capture time was moved';
  exception when check_violation then
    perform pg_temp.chk('a snapshot capture time cannot be moved', true);
  end;
end $$;

do $$
begin
  begin
    delete from public.editorial_snapshots where snapshot_id = 'snap_pub';
    raise exception 'FAIL: a snapshot was deleted';
  exception when check_violation then
    perform pg_temp.chk('a snapshot cannot be deleted', true);
  end;
end $$;

-- a harmless column CAN be corrected: the article id the snapshot belongs to
update public.editorial_snapshots set article_id = 'nfl-PUB' where snapshot_id = 'snap_pub';
select pg_temp.chk('a snapshot''s article_id may still be corrected',
  (select article_id from public.editorial_snapshots where snapshot_id = 'snap_pub') = 'nfl-PUB');

-- ---------------------------------------------------------------------------
-- 2  A PREGAME SNAPSHOT CANNOT POSTDATE KICKOFF.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into public.editorial_snapshots
      (snapshot_id, key, game_id, sport, captured_at, kickoff, payload)
    values ('snap_late', 'NFL:GAME_PUB', 'GAME_PUB', 'NFL',
            now(), now() - interval '3 hours', '{}'::jsonb);
    raise exception 'FAIL: a snapshot captured after kickoff was accepted';
  exception when check_violation then
    perform pg_temp.chk('a snapshot captured after kickoff is refused', true);
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 3  ONLY A PERSON CLOSES A MODEL-REVIEW CANDIDATE.
-- ---------------------------------------------------------------------------
insert into public.editorial_model_reviews (key, sport, category, question, occurrences, evidence)
values ('NFL:pressure:driver', 'NFL', 'pressure',
        'Does EdgeDesk''s pressure handling need investigating?', 2, '[]'::jsonb);

do $$
begin
  begin
    update public.editorial_model_reviews set status = 'closed' where key = 'NFL:pressure:driver';
    raise exception 'FAIL: a candidate was closed with no disposition';
  exception when check_violation then
    perform pg_temp.chk('a candidate cannot be closed with no disposition', true);
  end;
end $$;

do $$
begin
  begin
    update public.editorial_model_reviews
      set status = 'closed', disposition = 'no_change_needed', disposition_note = 'nope'
      where key = 'NFL:pressure:driver';
    raise exception 'FAIL: a candidate was closed with a one-word note';
  exception when check_violation then
    perform pg_temp.chk('a candidate cannot be closed with a note nobody could act on', true);
  end;
end $$;

do $$
begin
  begin
    update public.editorial_model_reviews
      set status = 'closed', disposition = 'no_change_needed',
          disposition_note = 'Checked against the 2016-2025 holdout: the pressure term is inside its stated error.'
      where key = 'NFL:pressure:driver';
    raise exception 'FAIL: a candidate was closed with no person attached';
  exception when check_violation then
    perform pg_temp.chk('a candidate cannot be closed without recording who closed it', true);
  end;
end $$;

update public.editorial_model_reviews
  set status = 'closed', disposition = 'no_change_needed',
      disposition_note = 'Checked against the 2016-2025 holdout: the pressure term is inside its stated error.',
      closed_by = '11111111-1111-1111-1111-111111111111'
  where key = 'NFL:pressure:driver';
select pg_temp.chk('a person with a disposition and a note may close one',
  (select status = 'closed' and closed_at is not null
   from public.editorial_model_reviews where key = 'NFL:pressure:driver'));

-- reopening clears the closure
update public.editorial_model_reviews set status = 'reopened' where key = 'NFL:pressure:driver';
select pg_temp.chk('reopening clears closed_at and closed_by',
  (select closed_at is null and closed_by is null
   from public.editorial_model_reviews where key = 'NFL:pressure:driver'));

-- ---------------------------------------------------------------------------
-- 4  THE FEATURED STATUS IS A FUNCTION OF THE TWO DECISIONS, NOT A TYPED VALUE.
-- ---------------------------------------------------------------------------
insert into public.editorial_featured_games
  (key, game_id, sport, away_team, home_team, editorial_priority, auto_selected, status)
values ('NFL:GAME_PUB', 'GAME_PUB', 'NFL', 'Away', 'Home', 62.0, true, 'considered');
select pg_temp.chk('an auto-selected game is featured whatever status was written',
  (select status from public.editorial_featured_games where key = 'NFL:GAME_PUB') = 'featured');

update public.editorial_featured_games set manual_override = 'unfeature' where key = 'NFL:GAME_PUB';
select pg_temp.chk('an operator UNFEATURE outranks the scorer',
  (select status from public.editorial_featured_games where key = 'NFL:GAME_PUB') = 'excluded');
select pg_temp.chk('and the override is stamped',
  (select overridden_at is not null from public.editorial_featured_games where key = 'NFL:GAME_PUB'));

update public.editorial_featured_games
  set manual_override = 'feature', auto_selected = false where key = 'NFL:GAME_PUB';
select pg_temp.chk('an operator FEATURE outranks the scorer too',
  (select status from public.editorial_featured_games where key = 'NFL:GAME_PUB') = 'featured');

do $$
begin
  begin
    update public.editorial_featured_games set manual_override = 'maybe' where key = 'NFL:GAME_PUB';
    raise exception 'FAIL: an unknown override was accepted';
  exception when check_violation then
    perform pg_temp.chk('an override outside feature/unfeature is refused', true);
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 5  THE FOUR VERDICTS AND THE FOUR PROCESS GRADES ARE THE ONLY ONES.
-- ---------------------------------------------------------------------------
insert into public.editorial_thesis_audits
  (key, game_id, sport, thesis_id, pregame_claim, evaluation)
values ('NFL:GAME_PUB', 'GAME_PUB', 'NFL', 'driver.1', 'A claim', 'NOT CONFIRMED');
do $$
begin
  begin
    insert into public.editorial_thesis_audits
      (key, game_id, sport, thesis_id, pregame_claim, evaluation)
    values ('NFL:GAME_PUB', 'GAME_PUB', 'NFL', 'driver.2', 'Another claim', 'SORT OF');
    raise exception 'FAIL: a fifth verdict was accepted';
  exception when check_violation then
    perform pg_temp.chk('a verdict outside the four is refused', true);
  end;
end $$;

insert into public.editorial_game_grades
  (key, game_id, sport, home_team, away_team, home_score, away_score,
   spread_result, process_grade, verdict_key)
values ('NFL:GAME_PUB', 'GAME_PUB', 'NFL', 'Home', 'Away', 27, 20,
        'win', 'UNSOUND', 'right_for_the_wrong_reason');
select pg_temp.chk('a winning number with an unsound process is storable as exactly that',
  (select spread_result = 'win' and process_grade = 'UNSOUND'
   from public.editorial_game_grades where key = 'NFL:GAME_PUB'));
do $$
begin
  begin
    update public.editorial_game_grades set process_grade = 'GOOD ENOUGH' where key = 'NFL:GAME_PUB';
    raise exception 'FAIL: a fifth process grade was accepted';
  exception when check_violation then
    perform pg_temp.chk('a process grade outside the four is refused', true);
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 6  THE RLS BOUNDARY. The research behind a DRAFT is invisible; the run log
--    is invisible to everybody but an operator.
-- ---------------------------------------------------------------------------
insert into public.editorial_snapshots
  (snapshot_id, key, game_id, sport, captured_at, kickoff, payload)
values ('snap_draft', 'NFL:GAME_DRAFT', 'GAME_DRAFT', 'NFL',
        now() - interval '6 hours', now() - interval '1 hour', '{}'::jsonb);
insert into public.editorial_runs (run, phase, step, key, ok, reason)
values ('run_test', 'pregame', 'pregame_validation', 'NFL:GAME_DRAFT', false,
        'held: the market number could not be read');

-- SET ROLE, NOT SET LOCAL ROLE. psql runs each statement in its own implicit
-- transaction, so a SET LOCAL is reverted before the next line and every
-- assertion below it would run as the superuser — which bypasses RLS and makes
-- the whole section pass without testing anything. It did, on the first run.
set role anon;
select pg_temp.chk('anon sees the snapshot behind a PUBLISHED article',
  (select count(*) from public.editorial_snapshots where snapshot_id = 'snap_pub') = 1);
select pg_temp.chk('anon does NOT see the snapshot behind a draft',
  (select count(*) from public.editorial_snapshots where snapshot_id = 'snap_draft') = 0);
select pg_temp.chk('anon does NOT see the run log at all',
  (select count(*) from public.editorial_runs) = 0);
select pg_temp.chk('anon does NOT see the model-review queue at all',
  (select count(*) from public.editorial_model_reviews) = 0);
select pg_temp.chk('anon sees the grade behind a published article',
  (select count(*) from public.editorial_game_grades) = 1);
do $$
begin
  begin
    insert into public.editorial_runs (run, step, ok) values ('anon', 'anything', true);
    raise exception 'FAIL: anon wrote to the run log';
  exception when insufficient_privilege then
    perform pg_temp.chk('anon cannot write the run log', true);
  end;
end $$;
do $$
begin
  begin
    insert into public.editorial_snapshots (snapshot_id, key, game_id, sport, captured_at, payload)
      values ('snap_anon', 'x', 'x', 'NFL', now(), '{}'::jsonb);
    raise exception 'FAIL: anon inserted a snapshot';
  exception when insufficient_privilege then
    perform pg_temp.chk('anon cannot insert a snapshot', true);
  end;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 7  A SIGNED-IN NON-OPERATOR IS NOT AN OPERATOR.
-- ---------------------------------------------------------------------------
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select pg_temp.chk('a signed-in reader is not an operator', public.site_article_is_admin() = false);
select pg_temp.chk('a reader does not see the run log',
  (select count(*) from public.editorial_runs) = 0);
do $$
begin
  begin
    update public.editorial_featured_games set manual_override = 'feature' where key = 'NFL:GAME_PUB';
    if not found then
      perform pg_temp.chk('a reader''s featured-game update matches no row', true);
    else
      raise exception 'FAIL: a reader changed a featured-game decision';
    end if;
  exception when insufficient_privilege then
    perform pg_temp.chk('a reader cannot change a featured-game decision', true);
  end;
end $$;
reset role;
reset request.jwt.claim.sub;

-- ---------------------------------------------------------------------------
-- 8  AN OPERATOR IS.
-- ---------------------------------------------------------------------------
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select pg_temp.chk('the operator is an operator', public.site_article_is_admin() = true);
select pg_temp.chk('the operator sees the run log', (select count(*) from public.editorial_runs) >= 1);
select pg_temp.chk('the operator sees a draft''s snapshot',
  (select count(*) from public.editorial_snapshots where snapshot_id = 'snap_draft') = 1);
update public.editorial_featured_games set manual_override = 'unfeature', operator_note = 'held back this week'
  where key = 'NFL:GAME_PUB';
select pg_temp.chk('the operator may unfeature a game',
  (select status from public.editorial_featured_games where key = 'NFL:GAME_PUB') = 'excluded');
do $$
begin
  begin
    update public.editorial_snapshots set payload = '{}'::jsonb where snapshot_id = 'snap_pub';
    /* WITH NO UPDATE POLICY, RLS DOES NOT RAISE — IT MATCHES NOTHING. That is
       the quieter of the two refusals and the one that actually fires here,
       so it is asserted as a refusal rather than mistaken for success. */
    if not found then
      perform pg_temp.chk('not even the operator may edit a snapshot: no update policy admits the row', true);
    else
      raise exception 'FAIL: the operator edited a snapshot';
    end if;
  exception when insufficient_privilege then
    perform pg_temp.chk('not even the operator may edit a snapshot: the grant refuses it', true);
  when check_violation then
    perform pg_temp.chk('not even the operator may edit a snapshot: the trigger refuses it', true);
  end;
end $$;
select pg_temp.chk('and the payload is still what was captured',
  (select payload::text like '%Home -3.0%' from public.editorial_snapshots where snapshot_id = 'snap_pub'));
reset role;
reset request.jwt.claim.sub;

do $$ begin raise notice 'ALL EDITORIAL SQL CHECKS PASSED'; end $$;
