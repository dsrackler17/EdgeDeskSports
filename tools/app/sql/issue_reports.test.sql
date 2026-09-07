-- ===========================================================================
-- EdgeDesk — "Report a problem", attacked on a real PostgreSQL.
--
-- The reason this table is allowed to accept writes from `anon` at all is that
-- the most valuable report in the product is "I could not sign up", and by
-- definition it is filed without a session. That concession is only safe if
-- three things are true, and they are what this suite proves rather than
-- asserts: an anonymous reporter cannot READ anything, nobody can file a
-- report under another account's id, and a reporter cannot see or edit
-- somebody else's report.
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

create or replace function pg_temp.as_user(p_id uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_id::text, false);
  execute 'set local role authenticated';
end; $$;
create or replace function pg_temp.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', false);
  execute 'set local role anon';
end; $$;
create or replace function pg_temp.as_owner() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', false);
  execute 'reset role';
end; $$;

do $test$
declare
  ALICE  constant uuid := '11111111-1111-1111-1111-111111111111';
  BOB    constant uuid := '22222222-2222-2222-2222-222222222222';
  OPS    constant uuid := '33333333-3333-3333-3333-333333333333';
  n      integer;
  rid    uuid;
  failed boolean;
begin
  insert into auth.users(id,email) values
    (ALICE,'alice@example.com'),(BOB,'bob@example.com'),(OPS,'ops@example.com')
  on conflict do nothing;
  insert into public.issue_report_admins(user_id,note) values (OPS,'test operator')
    on conflict do nothing;

  -- ── 1. anyone may file one ───────────────────────────────────────────────
  perform pg_temp.as_anon();
  insert into public.issue_reports(summary,details,category,route,auth_state,surface)
    values ('Signup did nothing','I clicked the link in the email and nothing happened.',
            'I could not sign up or log in','/','anonymous','landing');
  perform pg_temp.as_owner();
  select count(*) into n from public.issue_reports where surface='landing';
  perform pg_temp.ok('an anonymous visitor can file a report — the whole point', n = 1);

  perform pg_temp.as_user(ALICE);
  insert into public.issue_reports(user_id,user_email,summary,details,surface)
    values (ALICE,'alice@example.com','Board is empty','No rows on the edges tab.','app');
  perform pg_temp.as_user(BOB);
  insert into public.issue_reports(user_id,user_email,summary,details,surface)
    values (BOB,'bob@example.com','Bob''s report','filed by bob','app');
  perform pg_temp.ok('a signed-in reporter can file their own report', true);

  -- ── 2. nobody may file under somebody else's id ──────────────────────────
  failed := false;
  begin
    perform pg_temp.as_user(ALICE);
    insert into public.issue_reports(user_id,summary,details)
      values (BOB,'forged','alice claiming to be bob');
  exception when insufficient_privilege then failed := true;
  end;
  perform pg_temp.ok('a signed-in user CANNOT file a report under another account''s id', failed);

  failed := false;
  begin
    perform pg_temp.as_anon();
    insert into public.issue_reports(user_id,summary,details)
      values (ALICE,'forged','anon claiming to be alice');
  exception when insufficient_privilege then failed := true;
  end;
  perform pg_temp.ok('an anonymous visitor CANNOT file a report under an account id', failed);

  -- ── 3. anon can never read ───────────────────────────────────────────────
  perform pg_temp.as_anon();
  select count(*) into n from public.issue_reports;
  perform pg_temp.ok('anon reads NOTHING back — not even the report it just filed', n = 0,
                     'anon saw ' || n || ' rows');

  -- ── 4. a reporter sees only their own ────────────────────────────────────
  perform pg_temp.as_user(ALICE);
  select count(*) into n from public.issue_reports;
  perform pg_temp.ok('a reporter sees only their own reports', n = 1, 'alice saw ' || n);
  select count(*) into n from public.issue_reports where user_email = 'bob@example.com';
  perform pg_temp.ok('and cannot reach another reporter''s row or their email', n = 0);

  perform pg_temp.as_user(BOB);
  select count(*) into n from public.issue_reports;
  perform pg_temp.ok('the same, from the other side', n = 1, 'bob saw ' || n);

  -- ── 5. the operator sees everything ──────────────────────────────────────
  perform pg_temp.as_user(OPS);
  select count(*) into n from public.issue_reports;
  perform pg_temp.ok('an operator on the allowlist sees every report', n = 3, 'ops saw ' || n);

  -- ── 6. triage is the operator's alone ────────────────────────────────────
  select id into rid from public.issue_reports where surface='landing' limit 1;
  perform pg_temp.as_user(OPS);
  update public.issue_reports set status='triaged', severity='high', admin_notes='reproduced' where id=rid;
  perform pg_temp.as_owner();
  select count(*) into n from public.issue_reports where id=rid and status='triaged';
  perform pg_temp.ok('an operator can triage a report', n = 1);

  perform pg_temp.as_user(ALICE);
  update public.issue_reports set status='resolved' where id=rid;
  perform pg_temp.as_owner();
  select count(*) into n from public.issue_reports where id=rid and status='triaged';
  perform pg_temp.ok('a reporter cannot close somebody else''s report — the update matches no row', n = 1);

  -- a reporter cannot rewrite what they themselves said, either
  perform pg_temp.as_user(ALICE);
  update public.issue_reports set details='changed my mind' where user_id=ALICE;
  perform pg_temp.as_owner();
  select count(*) into n from public.issue_reports where user_id=ALICE and details='changed my mind';
  perform pg_temp.ok('a report is evidence: even its author cannot edit it after filing', n = 0);

  -- ── 7. nothing can be deleted through a client role ──────────────────────
  -- Two layers, and either one alone would do: the DELETE grant is revoked, and
  -- there is no delete policy for it to fall back on.
  failed := false;
  begin
    perform pg_temp.as_user(OPS);
    delete from public.issue_reports where id=rid;
  exception when insufficient_privilege then failed := true;
  end;
  perform pg_temp.as_owner();
  select count(*) into n from public.issue_reports where id=rid;
  perform pg_temp.ok('no client role can delete a report, operator included', failed and n = 1);

  failed := false;
  begin
    perform pg_temp.as_anon();
    delete from public.issue_reports;
  exception when insufficient_privilege then failed := true;
  end;
  perform pg_temp.as_owner();
  select count(*) into n from public.issue_reports;
  perform pg_temp.ok('and anon cannot wipe the table', failed and n = 3);

  -- ── 8. the allowlist itself is out of reach ──────────────────────────────
  failed := false;
  begin
    perform pg_temp.as_user(ALICE);
    perform 1 from public.issue_report_admins;
  exception when insufficient_privilege then failed := true;
  end;
  perform pg_temp.ok('the operator allowlist is not readable by a signed-in client', failed);

  failed := false;
  begin
    perform pg_temp.as_user(ALICE);
    insert into public.issue_report_admins(user_id) values (ALICE);
  exception when insufficient_privilege then failed := true;
  end;
  perform pg_temp.ok('and nobody can make themselves an operator from the browser', failed);

  -- ── 9. a credential can never be stored ──────────────────────────────────
  failed := false;
  begin
    perform pg_temp.as_anon();
    insert into public.issue_reports(summary,details) values
      ('token','my session is eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhYmNkZWZnaGlqIn0.c2lnbmF0dXJlX2hlcmU');
  exception when check_violation then failed := true;
  end;
  perform pg_temp.ok('a report containing a JWT is refused by the database', failed);

  failed := false;
  begin
    perform pg_temp.as_anon();
    insert into public.issue_reports(summary,details,page_url) values
      ('leak','nothing here','https://edgedesksports.com/#access_token=abc123');
  exception when check_violation then failed := true;
  end;
  perform pg_temp.ok('and a page_url still carrying an access_token is refused too', failed);

  -- ── 10. the shape constraints hold ───────────────────────────────────────
  failed := false;
  begin
    perform pg_temp.as_anon();
    insert into public.issue_reports(summary,details) values ('   ','   ');
  exception when check_violation then failed := true;
  end;
  perform pg_temp.ok('an empty report is refused rather than stored', failed);

  failed := false;
  begin
    perform pg_temp.as_owner();
    insert into public.issue_reports(summary,details,status) values ('x','y','invented');
  exception when check_violation then failed := true;
  end;
  perform pg_temp.ok('an unknown triage status is refused', failed);

  perform pg_temp.as_owner();
  raise notice 'ok   suite complete';
end
$test$;
