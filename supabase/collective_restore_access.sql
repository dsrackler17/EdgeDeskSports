-- ===========================================================================
-- Restore full Collective access to one account.
--
-- WHAT DECIDES WHAT AN ACCOUNT CAN DO. Three separate things, stored in three
-- different places, and none of them implies another:
--
--   * CREATOR (the slate uploader, the record, the profile) -- the creators
--     table must hold a row whose owning auth user is this account AND whose
--     status is 'active'. `collective_ingest` reads exactly that, in
--     `isEntitled()` (`user_id=eq.<uid>&status=eq.active`) and again on every
--     key lookup ("This creator account is not active."). Nothing else grants
--     it, and the slate uploader exists on no other page.
--   * ENTITLEMENT (every model's pre-kickoff numbers) -- follows from that
--     same active creator row: `isEntitled()` ORs creators with subscribers.
--     Nothing here writes to subscribers; a membership somebody paid for is
--     not a thing to manufacture in SQL.
--   * ADMIN (the admin page, the schedule loader, member removal) -- the auth
--     user id must appear in the config row keyed `admin.user_ids`, read by
--     `collective.mcr_is_admin()` and by `collective_admin`. A plain
--     allowlist: being a creator says nothing about it.
--
-- So an account can be an administrator of this Collective and still have no
-- uploader at all, which is the state this file exists to get out of. The two
-- ordinary causes: the creator row is owned by the account that redeemed the
-- invite rather than the one being signed in on, or a membership-only removal
-- moved the status off 'active' and stamped `removed_at`
-- (`collective_member_removal.sql`).
--
-- WHAT THIS FILE WRITES. Only what those checks read: the creator row's owner
-- and status, the removal stamps, and the auth user id onto
-- `config.admin.user_ids`. It does not touch a projection, a grade, a model, a
-- record, a subscription, or `auth.users`.
--
-- This is the one place the folder convention's "additive, nothing rewritten"
-- rule is deliberately broken, and it is the point of the file: it rewrites
-- the owner and the status of ONE named creator row. It rewrites nothing else,
-- and its report says exactly what it changed and what it left alone.
--
-- WHAT IT REFUSES. A creator row already owned by a DIFFERENT auth user is not
-- reassigned. Doing that silently moves somebody else's whole graded record
-- onto this account and neither of them can tell. The report says so and names
-- the flag to set if the reassignment really is intended.
--
-- NOT RESTORED HERE, on purpose: the API key and the embed origins a
-- membership-only removal deletes (it deletes every table whose name matches
-- key/token/secret/origin/invite/session/credential). Both are re-made from
-- the creator dashboard in one click each, and only a key's HASH is stored --
-- so a key written by hand is a key nobody can actually use.
--
-- COLUMN NAMES ARE DISCOVERED, not assumed. The Collective schema is not in
-- this repository: `collective/admin.html` reads `account_status` while
-- `collective_ingest` reads `status`, so this file finds the column the same
-- way `collective_member_removal.sql` does rather than guessing which one this
-- deployment has.
--
-- CONVENTION (supabase/README.md): idempotent, ends in a report. Safe to run
-- again, and again: a second run reports 'ok, already' on every step.
-- ===========================================================================

begin;

create temp table if not exists car_report (n serial, step text, outcome text, detail text);
truncate car_report;

-- The two discoveries every statement below is built on, as the removal file
-- writes them (collective.mcr_col / mcr_pk). Kept in pg_temp so this file
-- installs nothing: they vanish with the session.
create or replace function pg_temp.car_col(p_rel regclass, p_names text[])
returns text language sql stable as $fn$
  select a.attname::text
    from pg_attribute a
   where a.attrelid = p_rel and a.attnum > 0 and not a.attisdropped
     and a.attname::text = any (p_names)
   order by array_position(p_names, a.attname::text)
   limit 1;
$fn$;

create or replace function pg_temp.car_pk(p_rel regclass)
returns text language sql stable as $fn$
  select coalesce(
    (select a.attname::text
       from pg_constraint con
       join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
      where con.contype = 'p' and con.conrelid = p_rel and array_length(con.conkey, 1) = 1
      limit 1),
    pg_temp.car_col(p_rel, array['id']));
$fn$;

do $do$
declare
  -- ==== THE VALUES THIS FILE IS ABOUT ==================================== --
  p_email  text    := 'dsrackler@gmail.com';
  -- The creator row to attach. Leave it EMPTY to take whatever row this
  -- account already owns -- the "a removal closed it" case, where the owner is
  -- already right and only the status is wrong. Step 3 lists every slug.
  p_slug   text    := 'edgedesksports';
  -- Set true ONLY to take a row another auth user currently owns.
  p_claim  boolean := false;
  -- Set false to restore the creator row without touching the admin list.
  p_admin  boolean := true;
  -- ====================================================================== --
  v_rel    regclass;
  s        text;
  c_pk     text;
  c_slug   text;
  c_user   text;
  c_status text;
  c_name   text;
  cfg      regclass;
  k_col    text;
  v_col    text;
  keys     regclass;
  k_fk     text;
  v_uid    uuid;
  v_id     uuid;
  v_owner  uuid;
  v_name   text;
  v_status text;
  v_slug   text;
  lbl      text;
  ok_st    boolean;
  n        int;
begin
  -- 1 ---- the table, and what its columns are called ----------------------
  select c.oid::regclass into v_rel
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r', 'p')
     and c.relname = any (array['creators', 'members', 'contributors'])
   order by (n.nspname = 'collective') desc,
            array_position(array['creators', 'members', 'contributors'], c.relname::text)
   limit 1;
  if v_rel is null then
    insert into car_report(step, outcome, detail)
    values ('1 table', 'CHECK THIS', 'No creators / members / contributors table in any schema.');
    return;
  end if;
  select n.nspname into s
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = v_rel;

  c_pk     := pg_temp.car_pk(v_rel);
  c_slug   := pg_temp.car_col(v_rel, array['slug', 'creator_slug', 'handle']);
  c_user   := pg_temp.car_col(v_rel, array['user_id', 'auth_user_id', 'account_id', 'uid']);
  c_status := pg_temp.car_col(v_rel, array['account_status', 'status', 'state']);
  c_name   := pg_temp.car_col(v_rel, array['display_name', 'name', 'title']);

  insert into car_report(step, outcome, detail)
  values ('1 table', case when c_pk is null or c_slug is null or c_user is null
                          then 'CHECK THIS' else 'ok' end,
          v_rel::text || ' — id ' || coalesce(c_pk, 'NOT FOUND') ||
          ', slug ' || coalesce(c_slug, 'NOT FOUND') ||
          ', owner ' || coalesce(c_user, 'NOT FOUND') ||
          ', status ' || coalesce(c_status, 'none') ||
          ', name ' || coalesce(c_name, 'none'));
  if c_pk is null or c_slug is null or c_user is null then
    insert into car_report(step, outcome, detail)
    values ('1 table', 'CHECK THIS',
            'Without an id, a slug and an owner column there is nothing this file can attach.');
    return;
  end if;

  -- 2 ---- the account -----------------------------------------------------
  if to_regclass('auth.users') is null then
    insert into car_report(step, outcome, detail)
    values ('2 account', 'CHECK THIS', 'No auth.users table: this is not a Supabase database.');
    return;
  end if;
  execute 'select id from auth.users where lower(email) = lower($1)' into v_uid using p_email;
  if v_uid is null then
    insert into car_report(step, outcome, detail)
    values ('2 account', 'CHECK THIS',
            'No auth user with the email ' || p_email ||
            '. Check the spelling, or sign in once so the account exists.');
    return;
  end if;
  insert into car_report(step, outcome, detail)
  values ('2 account', 'ok', p_email || ' is auth user ' || v_uid::text);

  -- 3 ---- every creator row, and who owns it ------------------------------
  -- Printed before anything is written, so a run that then refuses still
  -- leaves you knowing what the table holds.
  execute format($q$
    select string_agg(%I || ' [' ||
             case when %I is null then 'unowned'
                  when %I = $1    then 'THIS ACCOUNT'
                  else 'another account' end
             || ', ' || %s || ']', ', ' order by %I)
      from %s $q$,
    c_slug, c_user, c_user,
    case when c_status is null then $$'no status column'$$
         else format($$coalesce(%I::text, 'no status')$$, c_status) end,
    c_slug, v_rel::text)
  into lbl using v_uid;
  insert into car_report(step, outcome, detail)
  values ('3 creator rows', 'ok', coalesce(lbl, 'none'));

  -- 4 ---- the row to restore ----------------------------------------------
  if coalesce(p_slug, '') <> '' then
    execute format('select %I, %I, %I, %s, %s from %s where %I = $1',
      c_pk, c_slug, c_user,
      coalesce(quote_ident(c_status), 'null::text'),
      coalesce(quote_ident(c_name), 'null::text'),
      v_rel::text, c_slug)
    into v_id, v_slug, v_owner, v_status, v_name using p_slug;
    if v_id is null then
      insert into car_report(step, outcome, detail)
      values ('4 creator row', 'CHECK THIS',
              'No creator row with slug ' || p_slug ||
              '. Pick one from step 3 and set p_slug at the top of this file.');
      return;
    end if;
  else
    execute format('select %I, %I, %I, %s, %s from %s where %I = $1 limit 1',
      c_pk, c_slug, c_user,
      coalesce(quote_ident(c_status), 'null::text'),
      coalesce(quote_ident(c_name), 'null::text'),
      v_rel::text, c_user)
    into v_id, v_slug, v_owner, v_status, v_name using v_uid;
    if v_id is null then
      insert into car_report(step, outcome, detail)
      values ('4 creator row', 'CHECK THIS',
              'This account owns no creator row and p_slug was left empty, so there is ' ||
              'nothing to restore. Set p_slug to one of the slugs in step 3.');
      return;
    end if;
  end if;
  insert into car_report(step, outcome, detail)
  values ('4 creator row', 'ok',
          v_slug || ' (' || coalesce(v_name, 'no display name') || '), status ' ||
          coalesce(v_status, 'none') || ', owner ' ||
          case when v_owner is null then 'unset'
               when v_owner = v_uid then 'already this account'
               else v_owner::text end);

  -- 5 ---- the owner -------------------------------------------------------
  if v_owner is not null and v_owner <> v_uid and not p_claim then
    insert into car_report(step, outcome, detail)
    values ('5 owner', 'CHECK THIS',
            v_slug || ' is owned by auth user ' || v_owner::text || ', not by ' || p_email ||
            '. Not reassigning it: that would move that account''s whole graded record onto ' ||
            'this one, and neither account could tell. If it really is yours, set ' ||
            'p_claim := true at the top and run again.');
  elsif v_owner is not distinct from v_uid then
    insert into car_report(step, outcome, detail)
    values ('5 owner', 'ok, already', 'Owner was already ' || p_email || '. Not written.');
  else
    execute format('update %s set %I = $2 where %I = $1', v_rel::text, c_user, c_pk)
      using v_id, v_uid;
    insert into car_report(step, outcome, detail)
    values ('5 owner', 'ok',
            v_slug || ' now belongs to ' || p_email ||
            case when v_owner is null then ' (it had no owner)'
                 else ' (claimed from ' || v_owner::text || ')' end);
  end if;

  -- Re-read it: everything below is about a row that is ours.
  execute format('select %I from %s where %I = $1', c_user, v_rel::text, c_pk)
    into v_owner using v_id;

  -- 6 ---- the status ------------------------------------------------------
  if c_status is null then
    insert into car_report(step, outcome, detail)
    values ('6 status', 'ok', 'This table has no status column; nothing gates on one.');
  elsif v_owner is distinct from v_uid then
    insert into car_report(step, outcome, detail)
    values ('6 status', 'skipped', 'The row is not owned by this account; status left as it is.');
  elsif v_status = 'active' then
    insert into car_report(step, outcome, detail)
    values ('6 status', 'ok, already', 'Status was already active. Not written.');
  else
    -- The column may be text or an enum with a fixed label set, so the first
    -- label it actually accepts wins: the mirror of what the removal does on
    -- the way out, where it tries removed/disabled/revoked/suspended/inactive.
    ok_st := false;
    foreach lbl in array array['active', 'approved', 'enabled', 'ok'] loop
      begin
        execute format('update %s set %I = %L where %I = $1', v_rel::text, c_status, lbl, c_pk)
          using v_id;
        ok_st := true;
        exit;
      exception when others then ok_st := false;
      end;
    end loop;
    if ok_st then
      insert into car_report(step, outcome, detail)
      values ('6 status', 'ok', c_status || ': ' || coalesce(v_status, 'null') || ' -> ' || lbl);
    else
      insert into car_report(step, outcome, detail)
      values ('6 status', 'CHECK THIS',
              'Could not set ' || c_status || ' to any of active/approved/enabled/ok. It is an ' ||
              'enum with different labels: set it by hand to whatever this deployment calls an ' ||
              'active creator. Everything else in this file is already done.');
    end if;
  end if;

  -- 7 ---- the removal stamps ----------------------------------------------
  -- Added by collective_member_removal.sql; absent on a deployment that has
  -- never installed it, which is not an error.
  if pg_temp.car_col(v_rel, array['removed_at']) is null then
    insert into car_report(step, outcome, detail)
    values ('7 removal stamps', 'ok', 'No removed_at column here; nothing to clear.');
  elsif v_owner is distinct from v_uid then
    insert into car_report(step, outcome, detail)
    values ('7 removal stamps', 'skipped', 'The row is not owned by this account.');
  else
    execute format('select count(*) from %s where %I = $1 and removed_at is not null',
      v_rel::text, c_pk) into n using v_id;
    if n = 0 then
      insert into car_report(step, outcome, detail)
      values ('7 removal stamps', 'ok, already', 'This row was never removed. Not written.');
    else
      execute format('update %s set removed_at = null, removed_by = null, removal_mode = null ' ||
                     'where %I = $1', v_rel::text, c_pk) using v_id;
      insert into car_report(step, outcome, detail)
      values ('7 removal stamps', 'ok', 'removed_at / removed_by / removal_mode cleared.');
    end if;
  end if;

  -- 8 ---- the admin allowlist ---------------------------------------------
  cfg := to_regclass(quote_ident(s) || '.config');
  if not p_admin then
    insert into car_report(step, outcome, detail)
    values ('8 admin', 'skipped', 'p_admin is false.');
  elsif cfg is null then
    insert into car_report(step, outcome, detail)
    values ('8 admin', 'CHECK THIS',
            'No ' || s || '.config table, so the admin allowlist cannot be written here. ' ||
            'A deployment that keeps its admins in ' || s || '.admins instead needs a row there.');
  else
    k_col := pg_temp.car_col(cfg, array['key', 'config_key', 'name', 'k', 'setting', 'id']);
    v_col := pg_temp.car_col(cfg, array['value', 'config_value', 'val', 'v', 'value_json', 'data']);
    if k_col is null or v_col is null then
      insert into car_report(step, outcome, detail)
      values ('8 admin', 'CHECK THIS',
              s || '.config has no key/value pair this file recognises. Add the auth user id ' ||
              'to admin.user_ids by hand.');
    else
      execute format('select coalesce(%I::text, '''') from %s where %I = $1', v_col, cfg::text, k_col)
        into lbl using 'admin.user_ids';
      if coalesce(lbl, '') like '%' || v_uid::text || '%' then
        insert into car_report(step, outcome, detail)
        values ('8 admin', 'ok, already', p_email || ' was already on admin.user_ids. Not written.');
      else
        -- Inside ON CONFLICT DO UPDATE the target row is referenced by the
        -- table's own alias -- schema-qualifying it there is an invalid
        -- FROM-clause reference and the whole statement fails. Existing ids
        -- are kept: this adds one administrator, it does not replace the list.
        execute format(
          'insert into %s (%I, %I) values ($1, $2)
             on conflict (%I) do update set %I =
               (select jsonb_agg(distinct x) from jsonb_array_elements(
                  coalesce(config.%I, ''[]''::jsonb) || $2) x)',
          cfg::text, k_col, v_col, k_col, v_col, v_col)
          using 'admin.user_ids', ('["' || v_uid::text || '"]')::jsonb;
        insert into car_report(step, outcome, detail)
        values ('8 admin', 'ok', p_email || ' added to admin.user_ids.');
      end if;
    end if;
  end if;

  -- 9 ---- credentials, counted and explained rather than written ----------
  keys := to_regclass(quote_ident(s) || '.api_keys');
  if keys is not null then
    k_fk := pg_temp.car_col(keys, array['creator_id', 'creator']);
    if k_fk is not null then
      execute format('select count(*) from %s where %I = $1', keys::text, k_fk) into n using v_id;
      insert into car_report(step, outcome, detail)
      values ('9 api keys', 'ok',
              n::text || ' key(s) on this creator. A membership-only removal deletes them; if ' ||
              'this is 0 and you want one, press Rotate on the creator dashboard. Not written ' ||
              'here: only the hash is stored, so a key written by hand is a key nobody can use.');
    end if;
  end if;

  -- 10 ---- what the account can do now, read back off the tables ----------
  -- Not a claim by this file: the same two reads collective_ingest makes.
  execute format('select count(*) from %s where %I = $1%s', v_rel::text, c_user,
    case when c_status is null then '' else format(' and %I = ''active''', c_status) end)
    into n using v_uid;
  insert into car_report(step, outcome, detail)
  values ('10 creator (uploader, record, profile)',
          case when n > 0 then 'ok' else 'CHECK THIS' end,
          case when n > 0 then n::text || ' active creator row(s) owned by ' || p_email ||
                               '. The slate uploader opens.'
               else 'No active creator row for this account. Read steps 4-6 above.' end);

  if cfg is not null and k_col is not null and v_col is not null then
    execute format('select coalesce(%I::text, '''') from %s where %I = $1', v_col, cfg::text, k_col)
      into lbl using 'admin.user_ids';
    insert into car_report(step, outcome, detail)
    values ('10 admin (admin page, schedule loader)',
            case when coalesce(lbl, '') like '%' || v_uid::text || '%' then 'ok' else 'CHECK THIS' end,
            case when coalesce(lbl, '') like '%' || v_uid::text || '%'
                 then 'On admin.user_ids.' else 'Not on admin.user_ids. Read step 8 above.' end);
  end if;

  insert into car_report(step, outcome, detail)
  values ('10 entitlement (pre-kickoff numbers)', 'ok',
          'Follows from the active creator row above: isEntitled() ORs creators with ' ||
          'subscribers, so nothing needs writing to subscribers.');
end
$do$;

commit;

-- The report runs after the commit, so reading it can never roll the file back.
select n, step, outcome, detail from car_report order by n;
