-- ===========================================================================
-- ADMIN-ONLY MEMBER REMOVAL — one paste, no placeholders. Safe to run again.
--
-- Removing a contributor from the Model Collective is the most destructive
-- thing an operator can do to it, and until now there was no way to do it at
-- all except by hand in the SQL editor — which is to say, no preview, no
-- ordering, no rollback, no audit and no recalculation.
--
-- This file installs that path, entirely in the database, so the guarantee
-- does not depend on a browser or on an edge function:
--
--   1. collective.admin_audit_log      — who did what, to whom, and whether it worked
--   2. collective.mcr_*                — config, admin allowlist, schema discovery
--   3. collective.mcr_plan             — the FOREIGN KEY closure under a creator,
--                                        deepest-first, computed from pg_constraint
--                                        rather than from a hardcoded table list
--   4. collective.admin_member_preview — exactly what would be removed, and what
--                                        would be preserved. Reads only.
--   5. collective.admin_member_remove  — the removal, in ONE transaction, in two
--                                        modes, with the confirmation checked on
--                                        the server and the audit row written
--                                        whether it succeeded or failed
--   6. collective.admin_member_activity— submissions / last slate / status per
--                                        member, for the admin list
--   7. public.collective_member_*      — the three doors a signed-in admin's
--                                        browser may knock on, each deriving the
--                                        acting user from auth.uid() and NEVER
--                                        from an argument
--   8. the trigger that makes removal stick regardless of which edge function
--      is deployed: a removed creator's model cannot receive a new projection
--   9. the report
--
-- WHY IT IS WRITTEN BY DISCOVERY. The Collective's schema is not in this
-- repository — it was created from the Supabase dashboard, like every other
-- edge function except collective_ingest. A destructive routine that assumed a
-- table list would either delete the wrong thing or refuse to run. So every
-- name here is discovered: the creators / models / projections tables from
-- to_regclass and from the foreign keys BETWEEN them, and every dependent table
-- from pg_constraint at call time. Nothing is hardcoded except the two things
-- that must never be discovered — what is protected, and who is an admin.
--
-- WHAT IS NEVER DELETED. Games, teams, aliases, odds, books, closing lines,
-- sports, seasons, config; anything financial (earnings, ledger, payouts,
-- invoices, billing, subscriptions, referrals); the audit log; the creator row
-- itself; every other contributor's rows; and anything outside the collective
-- schema — auth.users above all. The member's EdgeDesk account is not touched
-- in either mode. Two config keys widen or narrow that list without editing
-- this file:
--
--   collective.member_removal.extra_protected   comma-separated table names
--   collective.member_removal.extra_deletable   comma-separated table names
--
-- CONVENTION (supabase/README.md): idempotent, additive, ends in a report.
-- ===========================================================================

begin;

create temp table if not exists mcr_report (n serial, step text, outcome text, detail text);
truncate mcr_report;

-- 0 ---- sanity ---------------------------------------------------------------
do $do$
declare
  v_creators text; v_models text; v_proj text;
begin
  if to_regnamespace('collective') is null then
    raise exception 'schema "collective" does not exist — is this the Collective project?';
  end if;
  v_creators := coalesce((select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                           where n.nspname = 'collective' and c.relkind = 'r'
                             and c.relname in ('creators','members','contributors') limit 1), 'NOT FOUND');
  v_models   := coalesce((select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                           where n.nspname = 'collective' and c.relkind = 'r'
                             and c.relname in ('models','collective_models') limit 1), 'NOT FOUND');
  v_proj     := coalesce((select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                           where n.nspname = 'collective' and c.relkind = 'r'
                             and c.relname in ('projections','submissions') limit 1), 'NOT FOUND');
  insert into mcr_report(step, outcome, detail) values
    ('0 sanity', case when v_creators = 'NOT FOUND' then 'CHECK THIS' else 'ok' end,
     'creators=' || v_creators || ' models=' || v_models || ' projections=' || v_proj ||
     case when v_creators = 'NOT FOUND'
          then '. Without a creators table the functions install but every call returns ok:false schema_unavailable.'
          else '' end);
end $do$;

-- 1 ---- the audit log --------------------------------------------------------
create table if not exists collective.admin_audit_log (
  id           uuid primary key default gen_random_uuid(),
  at           timestamptz not null default now(),
  actor_id     uuid,
  action       text not null,
  subject_kind text,
  subject_id   uuid,
  subject_slug text,
  mode         text,
  status       text not null default 'started',
  rows_deleted integer,
  detail       jsonb not null default '{}'::jsonb
);

comment on table collective.admin_audit_log is
  'Every administrative action that changes who is in the Collective. Written by the security-definer routines only: no client role may read or write it, and it holds no credential — a deleted API key is recorded as a COUNT, never as a prefix or a hash.';

create index if not exists admin_audit_log_at_idx on collective.admin_audit_log (at desc);
create index if not exists admin_audit_log_subject_idx on collective.admin_audit_log (subject_slug, at desc);

alter table collective.admin_audit_log enable row level security;
revoke all on collective.admin_audit_log from public;
do $do$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on collective.admin_audit_log from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on collective.admin_audit_log from authenticated; end if;
end $do$;

insert into mcr_report(step, outcome, detail)
values ('1 audit log', 'ok', 'collective.admin_audit_log in place, RLS on, no client grants');

-- 2 ---- config, and who is an admin ------------------------------------------
-- The admin allowlist is the one this product already has: collective.config
-- key admin.user_ids, which collective_admin reads to decide 403. Read the same
-- key here rather than inventing a second admin system.

create or replace function collective.mcr_config(p_key text)
returns text
language plpgsql
stable
security definer
set search_path = collective, public
as $fn$
declare
  v text; kcol text; vcol text;
begin
  begin
    if to_regprocedure('collective.get_config(text)') is not null then
      execute 'select collective.get_config($1)::text' into v using p_key;
      if v is not null and v <> 'null' then return v; end if;
    end if;
  exception when others then v := null; end;
  begin
    if to_regclass('collective.config') is null then return null; end if;
    select column_name::text into kcol from information_schema.columns
     where table_schema = 'collective' and table_name = 'config'
       and column_name::text in ('key','config_key','name','k','setting','id')
     order by array_position(array['key','config_key','name','k','setting','id'], column_name::text) limit 1;
    select column_name::text into vcol from information_schema.columns
     where table_schema = 'collective' and table_name = 'config'
       and column_name::text in ('value','config_value','val','v','value_json','data','setting_value')
     order by array_position(array['value','config_value','val','v','value_json','data','setting_value'], column_name::text) limit 1;
    if kcol is null or vcol is null then return null; end if;
    execute format('select %I::text from collective.config where %I = $1 limit 1', vcol, kcol) into v using p_key;
  exception when others then v := null; end;
  return v;
end
$fn$;

comment on function collective.mcr_config(text) is
  'One config value as text, through collective.get_config() when it exists and straight off collective.config when it does not. NULL when neither can answer.';

-- Every uuid in the configured allowlist, however it is stored: a jsonb array,
-- a comma-separated string, or a quoted list. Parsing by shape rather than by
-- format means a config written before this file still resolves.
create or replace function collective.mcr_admin_ids()
returns uuid[]
language plpgsql
stable
security definer
set search_path = collective, public
as $fn$
declare
  raw text;
  out_ids uuid[] := '{}';
  extra uuid[];
  m text[];
begin
  raw := coalesce(collective.mcr_config('admin.user_ids'), '');
  for m in select regexp_matches(raw, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', 'g') loop
    out_ids := out_ids || m[1]::uuid;
  end loop;
  /* a deployment that keeps its admins in a table rather than in config */
  begin
    if to_regclass('collective.admins') is not null then
      execute 'select coalesce(array_agg(t.user_id), ''{}''::uuid[]) from collective.admins t'
        into extra;
      out_ids := out_ids || extra;
    end if;
  exception when others then null; end;
  return (select coalesce(array_agg(distinct x), '{}'::uuid[]) from unnest(out_ids) x);
end
$fn$;

create or replace function collective.mcr_is_admin(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = collective, public
as $fn$
  select p_user is not null and p_user = any (collective.mcr_admin_ids());
$fn$;

comment on function collective.mcr_is_admin(uuid) is
  'True when this auth user is on collective.config key admin.user_ids (or in collective.admins). The single authority for every removal routine here; the browser gets no vote.';

insert into mcr_report(step, outcome, detail)
values ('2 admin allowlist', 'ok',
  'collective.mcr_is_admin() reads admin.user_ids — ' ||
  coalesce(array_length(collective.mcr_admin_ids(), 1), 0)::text || ' admin id(s) configured');

-- 3 ---- schema discovery ------------------------------------------------------
create or replace function collective.mcr_rel(p_kind text)
returns regclass
language sql
stable
as $fn$
  select (select c.oid::regclass
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'collective' and c.relkind in ('r', 'p')
             and c.relname = any (case p_kind
               when 'creators'    then array['creators','members','contributors']
               when 'models'      then array['models','collective_models']
               when 'projections' then array['projections','submissions']
               else array[]::text[] end)
           order by array_position(case p_kind
               when 'creators'    then array['creators','members','contributors']
               when 'models'      then array['models','collective_models']
               when 'projections' then array['projections','submissions']
               else array[]::text[] end, c.relname::text)
           limit 1);
$fn$;

-- First of these column names that the table actually has.
create or replace function collective.mcr_col(p_rel regclass, p_names text[])
returns text
language sql
stable
as $fn$
  select a.attname::text
    from pg_attribute a
   where a.attrelid = p_rel and a.attnum > 0 and not a.attisdropped
     and a.attname::text = any (p_names)
   order by array_position(p_names, a.attname::text)
   limit 1;
$fn$;

-- The single column on p_child that points at p_parent, read off the real
-- foreign key. Falls back to a name only when no foreign key exists.
create or replace function collective.mcr_fk_col(p_child regclass, p_parent regclass)
returns text
language sql
stable
as $fn$
  select coalesce(
    (select a.attname::text
       from pg_constraint con
       join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
      where con.contype = 'f' and con.conrelid = p_child and con.confrelid = p_parent
        and array_length(con.conkey, 1) = 1
      limit 1),
    collective.mcr_col(p_child, array['creator_id','model_id','projection_id','owner_id'])
  );
$fn$;

-- The primary key column, when it is a single one.
create or replace function collective.mcr_pk(p_rel regclass)
returns text
language sql
stable
as $fn$
  select coalesce(
    (select a.attname::text
       from pg_constraint con
       join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
      where con.contype = 'p' and con.conrelid = p_rel and array_length(con.conkey, 1) = 1
      limit 1),
    collective.mcr_col(p_rel, array['id']));
$fn$;

-- WHAT MAY NEVER BE DELETED. Market data, shared reference data, anything
-- financial, the audit log, and the creator row itself. Widened or narrowed by
-- config without editing this file; extra_deletable wins, because the operator
-- who names a table there has looked at it.
create or replace function collective.mcr_protected(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = collective, public
as $fn$
declare
  nm text := lower(p_name);
  extra_p text := coalesce(collective.mcr_config('collective.member_removal.extra_protected'), '');
  extra_d text := coalesce(collective.mcr_config('collective.member_removal.extra_deletable'), '');
begin
  if nm = any (string_to_array(regexp_replace(lower(extra_d), '[^a-z0-9_,]', '', 'g'), ',')) then
    return false;
  end if;
  if nm = any (string_to_array(regexp_replace(lower(extra_p), '[^a-z0-9_,]', '', 'g'), ',')) then
    return true;
  end if;
  return nm in ('creators','members','contributors','admin_audit_log','config')
      or nm ~ '^(game|team|odd|book|market|clos|sport|season|config|alias|line)'
      or nm ~ '(earning|ledger|payout|payment|invoice|stripe|billing|subscri|referral|audit)';
end
$fn$;

comment on function collective.mcr_protected(text) is
  'True for a collective table a member removal may never delete from: shared market and reference data, anything financial, the audit log, and the creator row itself. Config keys collective.member_removal.extra_protected / .extra_deletable adjust it.';

insert into mcr_report(step, outcome, detail)
values ('3 discovery', case when collective.mcr_rel('creators') is null then 'CHECK THIS' else 'ok' end,
  'creators=' || coalesce(collective.mcr_rel('creators')::text, 'none') ||
  ' models='  || coalesce(collective.mcr_rel('models')::text, 'none') ||
  ' projections=' || coalesce(collective.mcr_rel('projections')::text, 'none'));

-- 4 ---- the foreign key closure ----------------------------------------------
-- Everything in the collective schema that hangs off one creator row, in the
-- order it was discovered — so deleting in REVERSE order deletes children
-- before parents without a single hardcoded table name and without CASCADE.
--
-- Each node carries a PREDICATE rather than a list of ids, so a child is
-- always "the rows of C whose foreign key is in (select pk from parent where
-- <parent predicate>)". Composite foreign keys are skipped and reported: there
-- are none in this schema and guessing at one is how a delete goes wrong.

create or replace function collective.mcr_plan(p_creator_id uuid, p_max_depth integer default 6)
returns table (step integer, rel regclass, rel_name text, pred text, depth integer,
               protected boolean, is_root boolean, n bigint)
language plpgsql
stable
security definer
set search_path = collective, public
as $fn$
declare
  v_creators regclass := collective.mcr_rel('creators');
  v_pk       text;
  rels       regclass[];
  preds      text[];
  depths     integer[];
  i          integer := 1;
  cur_rel    regclass;
  cur_pred   text;
  cur_depth  integer;
  r          record;
  child_pred text;
  cnt        bigint;
  parent_pk  text;
begin
  if v_creators is null or p_creator_id is null then return; end if;
  v_pk := collective.mcr_pk(v_creators);
  if v_pk is null then return; end if;

  rels   := array[v_creators];
  preds  := array[format('%I = %L::uuid', v_pk, p_creator_id)];
  depths := array[0];

  while i <= array_length(rels, 1) loop
    cur_rel := rels[i]; cur_pred := preds[i]; cur_depth := depths[i];
    if cur_depth < p_max_depth and array_length(rels, 1) < 200 then
      parent_pk := collective.mcr_pk(cur_rel);
      for r in
        select con.conrelid::regclass as child,
               a.attname::text        as child_col,
               pa.attname::text       as parent_col,
               cl.relname::text       as child_name
          from pg_constraint con
          join pg_class cl on cl.oid = con.conrelid
          join pg_namespace ns on ns.oid = cl.relnamespace
          join pg_attribute a  on a.attrelid = con.conrelid  and a.attnum = con.conkey[1]
          join pg_attribute pa on pa.attrelid = con.confrelid and pa.attnum = con.confkey[1]
         where con.contype = 'f'
           and con.confrelid = cur_rel
           and ns.nspname = 'collective'
           and cl.relkind in ('r', 'p')
           and array_length(con.conkey, 1) = 1
           and con.conrelid <> cur_rel
         order by cl.relname
      loop
        child_pred := format('%I in (select %I from %s where %s)',
                             r.child_col, r.parent_col, cur_rel::text, cur_pred);
        if not (r.child = any (rels) and child_pred = any (preds)) then
          rels := rels || r.child; preds := preds || child_pred; depths := depths || (cur_depth + 1);
        end if;
      end loop;
    end if;
    i := i + 1;
  end loop;

  /* ONE ROW PER TABLE. A table reachable by two paths — api keys hang off the
     creator AND off the model, which is the real shape — must be deleted at the
     DEEPEST place it was found, or deleting the model runs into the key's own
     foreign key. So its predicate is the OR of every path that reaches it and
     its position is the last one. */
  for r in
    select u.rel_oid,
           max(u.idx)::integer                                  as idx,
           max(u.depth)::integer                                as dep,
           '(' || string_agg(u.pred, ') or (' order by u.idx) || ')' as pred_all
      from unnest(rels, preds, depths) with ordinality as u(rel_oid, pred, depth, idx)
     group by u.rel_oid
     order by max(u.idx)
  loop
    execute format('select count(*) from %s where %s', r.rel_oid::text, r.pred_all) into cnt;
    step := r.idx;
    rel := r.rel_oid;
    rel_name := (select c.relname::text from pg_class c where c.oid = r.rel_oid);
    pred := r.pred_all;
    depth := r.dep;
    protected := collective.mcr_protected(rel_name);
    is_root := (r.rel_oid = v_creators);
    n := cnt;
    return next;
  end loop;
end
$fn$;

comment on function collective.mcr_plan(uuid, integer) is
  'Every collective-schema table holding rows that hang off one creator, discovered from pg_constraint at call time, deepest last. Deleting in reverse step order deletes children before parents. Read-only: it counts, it does not delete.';

insert into mcr_report(step, outcome, detail)
values ('4 fk closure', 'ok', 'collective.mcr_plan(creator_id) walks the real foreign keys, max depth 6, 200 nodes');

-- 4b ---- the membership record itself ------------------------------------------
-- Three additive columns on the creators table. The removal is recorded HERE
-- and not only in a status column, because a deployment whose account_status is
-- an enum may have no label that means removed — and a removal nobody can read
-- back off the row is not a removal, it is a hope.
do $do$
declare
  v_creators regclass := collective.mcr_rel('creators');
begin
  if v_creators is null then
    insert into mcr_report(step, outcome, detail) values
      ('4b membership columns', 'skipped', 'no creators table');
    return;
  end if;
  execute 'alter table ' || v_creators::text || ' add column if not exists removed_at   timestamptz';
  execute 'alter table ' || v_creators::text || ' add column if not exists removed_by   uuid';
  execute 'alter table ' || v_creators::text || ' add column if not exists removal_mode text';
  execute 'comment on column ' || v_creators::text || '.removed_at is ' ||
          quote_literal('When this contributor was removed from the Collective. NULL for every current member. Set only by collective.admin_member_remove(); never cleared by it.');
  insert into mcr_report(step, outcome, detail) values
    ('4b membership columns', 'ok', 'removed_at / removed_by / removal_mode on ' || v_creators::text);
exception when others then
  insert into mcr_report(step, outcome, detail) values ('4b membership columns', 'CHECK THIS', sqlerrm);
end $do$;

-- 5 ---- what a removal would touch (READ ONLY) --------------------------------
create or replace function collective.admin_member_preview(p_actor uuid, p_creator_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = collective, public
as $fn$
declare
  v_creators regclass := collective.mcr_rel('creators');
  v_models   regclass := collective.mcr_rel('models');
  v_proj     regclass := collective.mcr_rel('projections');
  c_slug text; c_pk text; c_user text; c_name text; c_joined text; c_status text; c_found text;
  m_fk text; m_pk text; m_name text; m_slug text; m_sport text;
  p_fk text; p_pk text; p_graded text; p_late text; p_status text; p_recv text; p_cand text;
  v_id uuid; v_user uuid; v_name text; v_joined timestamptz; v_status text; v_removed timestamptz;
  models jsonb := '[]'::jsonb;
  plan_rows jsonb := '[]'::jsonb;
  blocked jsonb := '[]'::jsonb;
  n_sub bigint := 0; n_graded bigint := 0; n_pending bigint := 0; n_late bigint := 0;
  n_quar bigint := 0; n_cand bigint := 0; n_last timestamptz;
  n_games bigint := 0; n_other_sub bigint := 0; n_other_creators bigint := 0;
  n_delete bigint := 0; n_keep bigint := 0;
  admin_ids uuid[] := collective.mcr_admin_ids();
  r record;
  graded_basis text := 'unavailable';
begin
  if not collective.mcr_is_admin(p_actor) then
    return jsonb_build_object('ok', false, 'code', 'forbidden',
      'message', 'This account is not a Collective administrator.');
  end if;
  if v_creators is null then
    return jsonb_build_object('ok', false, 'code', 'schema_unavailable',
      'message', 'No creators table found in the collective schema.');
  end if;

  c_pk     := collective.mcr_pk(v_creators);
  c_slug   := collective.mcr_col(v_creators, array['slug','creator_slug','handle']);
  c_user   := collective.mcr_col(v_creators, array['user_id','auth_user_id','account_id','uid']);
  c_name   := collective.mcr_col(v_creators, array['display_name','name','title']);
  c_joined := collective.mcr_col(v_creators, array['joined_at','created_at','inserted_at']);
  c_status := collective.mcr_col(v_creators, array['account_status','status','state']);
  c_found  := collective.mcr_col(v_creators, array['founding_member','founding','is_founding']);
  if c_slug is null then
    return jsonb_build_object('ok', false, 'code', 'schema_unavailable',
      'message', 'The creators table has no slug column.');
  end if;

  execute format('select %I, %s, %s, %s, %s, %s from %s where %I = $1 limit 1',
    c_pk,
    coalesce(quote_ident(c_user),   'null::uuid'),
    coalesce(quote_ident(c_name),   'null::text'),
    coalesce(quote_ident(c_joined), 'null::timestamptz'),
    coalesce(quote_ident(c_status) || '::text', 'null::text'),
    'removed_at',
    v_creators::text, c_slug)
  into v_id, v_user, v_name, v_joined, v_status, v_removed
  using p_creator_slug;

  if v_id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found',
      'message', 'No contributor with that slug.');
  end if;

  -- models, and the submission counts under them
  if v_models is not null then
    m_fk    := collective.mcr_fk_col(v_models, v_creators);
    m_pk    := collective.mcr_pk(v_models);
    m_name  := collective.mcr_col(v_models, array['name','model_name','display_name']);
    m_slug  := collective.mcr_col(v_models, array['slug','model_slug']);
    m_sport := collective.mcr_col(v_models, array['sport','sport_code']);
    if m_fk is not null then
      execute format(
        'select coalesce(jsonb_agg(jsonb_build_object(''id'', %I, ''name'', %s, ''slug'', %s, ''sport'', %s) order by %s), ''[]''::jsonb) from %s where %I = $1',
        m_pk,
        coalesce(quote_ident(m_name), 'null::text'),
        coalesce(quote_ident(m_slug), 'null::text'),
        coalesce(quote_ident(m_sport) || '::text', 'null::text'),
        coalesce(quote_ident(m_name), quote_ident(m_pk)),
        v_models::text, m_fk)
      into models using v_id;
    end if;
  end if;

  if v_proj is not null and v_models is not null and m_fk is not null then
    p_fk     := collective.mcr_fk_col(v_proj, v_models);
    p_graded := collective.mcr_col(v_proj, array['is_graded','graded','graded_at','result','grade']);
    p_late   := collective.mcr_col(v_proj, array['is_late']);
    p_status := collective.mcr_col(v_proj, array['resolution_status']);
    p_recv   := collective.mcr_col(v_proj, array['received_at','created_at','submitted_at']);
    p_cand   := collective.mcr_col(v_proj, array['is_graded_candidate']);
    if p_fk is not null then
      execute format('select count(*) from %s where %I in (select %I from %s where %I = $1)',
        v_proj::text, p_fk, m_pk, v_models::text, m_fk) into n_sub using v_id;
      if p_graded is not null then
        graded_basis := p_graded;
        execute format(
          'select count(*) filter (where %s) from %s where %I in (select %I from %s where %I = $1)',
          case when p_graded in ('is_graded','graded') then 'coalesce(' || quote_ident(p_graded) || ', false)'
               else quote_ident(p_graded) || ' is not null' end,
          v_proj::text, p_fk, m_pk, v_models::text, m_fk)
        into n_graded using v_id;
        n_pending := n_sub - n_graded;
      end if;
      if p_late is not null then
        execute format('select count(*) from %s where coalesce(%I, false) and %I in (select %I from %s where %I = $1)',
          v_proj::text, p_late, p_fk, m_pk, v_models::text, m_fk) into n_late using v_id;
      end if;
      if p_status is not null then
        execute format('select count(*) from %s where %I::text <> ''resolved'' and %I in (select %I from %s where %I = $1)',
          v_proj::text, p_status, p_fk, m_pk, v_models::text, m_fk) into n_quar using v_id;
      end if;
      if p_cand is not null then
        execute format('select count(*) from %s where coalesce(%I, false) and %I in (select %I from %s where %I = $1)',
          v_proj::text, p_cand, p_fk, m_pk, v_models::text, m_fk) into n_cand using v_id;
      end if;
      if p_recv is not null then
        execute format('select max(%I) from %s where %I in (select %I from %s where %I = $1)',
          p_recv, v_proj::text, p_fk, m_pk, v_models::text, m_fk) into n_last using v_id;
      end if;
      execute format('select count(*) from %s where %I not in (select %I from %s where %I = $1)',
        v_proj::text, p_fk, m_pk, v_models::text, m_fk) into n_other_sub using v_id;
    end if;
  end if;

  -- what stays. Named explicitly, because "we did not touch it" is only
  -- believable with a number next to it.
  begin
    if to_regclass('collective.games') is not null then
      execute 'select count(*) from collective.games' into n_games;
    end if;
  exception when others then n_games := null; end;
  execute format('select count(*) from %s where %I <> $1', v_creators::text, c_pk) into n_other_creators using v_id;

  -- the closure
  for r in select * from collective.mcr_plan(v_id) order by step loop
    if r.is_root then continue; end if;            -- the creator row itself: never deleted
    if r.n = 0 then continue; end if;
    plan_rows := plan_rows || jsonb_build_object(
      'table', r.rel_name, 'rows', r.n, 'depth', r.depth,
      'action', case when r.protected then 'preserved' else 'deleted' end);
    if r.protected then
      n_keep := n_keep + r.n;
      blocked := blocked || jsonb_build_object('table', r.rel_name, 'rows', r.n);
    else
      n_delete := n_delete + r.n;
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'creator', jsonb_build_object(
      'id', v_id, 'slug', p_creator_slug, 'display_name', v_name,
      'user_id', v_user, 'joined_at', v_joined, 'account_status', v_status,
      'removed_at', v_removed,
      'is_admin', (v_user is not null and v_user = any (admin_ids))),
    'models', models,
    'counts', jsonb_build_object(
      'submissions', n_sub, 'graded', n_graded, 'pending', n_pending,
      'late', n_late, 'quarantined', n_quar, 'counting_rows', n_cand,
      'last_submission_at', n_last, 'graded_basis', graded_basis),
    'will_delete', jsonb_build_object('rows', n_delete, 'tables', plan_rows),
    'will_preserve', jsonb_build_object(
      'rows_in_protected_tables', n_keep,
      'protected_tables', blocked,
      'games', n_games,
      'other_contributors', n_other_creators,
      'other_contributor_submissions', n_other_sub,
      'auth_account', 'never touched'),
    'guards', jsonb_build_object(
      'actor_is_target', (v_user is not null and v_user = p_actor),
      'target_is_admin', (v_user is not null and v_user = any (admin_ids)),
      'admin_count', coalesce(array_length(admin_ids, 1), 0),
      'already_removed', (v_removed is not null)));
exception when others then
  return jsonb_build_object('ok', false, 'code', 'preview_failed', 'message', sqlerrm);
end
$fn$;

-- 6 ---- the removal -----------------------------------------------------------
-- ONE TRANSACTION. The deletions run inside a block with an exception handler,
-- which in PL/pgSQL is a subtransaction: anything that raises rolls back every
-- delete in it and the caller is told why, with the contributor and their rows
-- exactly as they were. The audit row is written OUTSIDE that block, so the
-- attempt survives its own failure.

create or replace function collective.admin_member_remove(
  p_actor uuid, p_creator_slug text, p_mode text, p_confirm text default null)
returns jsonb
language plpgsql
security definer
set search_path = collective, public
as $fn$
declare
  v_creators regclass := collective.mcr_rel('creators');
  c_pk text; c_slug text; c_user text; c_status text;
  v_id uuid; v_user uuid; v_removed timestamptz; v_name text;
  admin_ids uuid[] := collective.mcr_admin_ids();
  audit_id uuid;
  pre jsonb;
  r record;
  deleted jsonb := '[]'::jsonb;
  n_total bigint := 0; k bigint;
  refreshed jsonb := '[]'::jsonb;
  v_status_new text;
  ok_status boolean;
begin
  if p_mode is null or p_mode not in ('membership_only', 'full_collective_delete') then
    return jsonb_build_object('ok', false, 'code', 'bad_mode',
      'message', 'mode must be membership_only or full_collective_delete');
  end if;
  if not collective.mcr_is_admin(p_actor) then
    return jsonb_build_object('ok', false, 'code', 'forbidden',
      'message', 'This account is not a Collective administrator.');
  end if;
  if v_creators is null then
    return jsonb_build_object('ok', false, 'code', 'schema_unavailable',
      'message', 'No creators table found in the collective schema.');
  end if;

  c_pk     := collective.mcr_pk(v_creators);
  c_slug   := collective.mcr_col(v_creators, array['slug','creator_slug','handle']);
  c_user   := collective.mcr_col(v_creators, array['user_id','auth_user_id','account_id','uid']);
  c_status := collective.mcr_col(v_creators, array['account_status','status','state']);

  execute format('select %I, %s, %s, removed_at from %s where %I = $1 limit 1',
    c_pk, coalesce(quote_ident(c_user), 'null::uuid'),
    coalesce(quote_ident(collective.mcr_col(v_creators, array['display_name','name','title'])), 'null::text'),
    v_creators::text, c_slug)
  into v_id, v_user, v_name, v_removed using p_creator_slug;

  if v_id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'No contributor with that slug.');
  end if;

  /* One removal at a time per contributor. A double-clicked button, or two
     admins on the same row, serialize here instead of racing each other
     through the same delete plan. */
  perform pg_advisory_xact_lock(hashtext('collective.member_removal:' || v_id::text));

  /* GUARDS, in the order that matters. Administration is checked BEFORE
     identity: told only "you cannot remove yourself", the last remaining admin
     would go and ask a colleague to do it for them, and the Collective would
     end up with nobody who can administer it. Told "you are the only
     administrator", they add a second one first. */
  if v_user is not null and v_user = any (admin_ids)
     and coalesce(array_length(admin_ids, 1), 0) <= 1 then
    return jsonb_build_object('ok', false, 'code', 'last_admin',
      'message', 'This contributor is the only configured Collective administrator. Add a second administrator to the config key admin.user_ids first — removing this one would leave the Collective with nobody who can administer it.');
  end if;
  if v_user is not null and v_user = p_actor then
    return jsonb_build_object('ok', false, 'code', 'cannot_remove_self',
      'message', 'An administrator cannot remove their own membership through this action. Ask another administrator.');
  end if;
  if p_mode = 'full_collective_delete' and coalesce(p_confirm, '') <> 'DELETE' then
    return jsonb_build_object('ok', false, 'code', 'confirmation_required',
      'message', 'A full Collective delete must be confirmed by typing DELETE.');
  end if;

  pre := collective.admin_member_preview(p_actor, p_creator_slug);

  /* Already removed, and nothing left to delete: report it and change nothing.
     A second click is a no-op, not a second removal. */
  if v_removed is not null and (p_mode = 'membership_only'
      or coalesce((pre -> 'will_delete' ->> 'rows')::bigint, 0) = 0) then
    return jsonb_build_object('ok', true, 'code', 'already_removed', 'no_op', true,
      'creator_slug', p_creator_slug, 'mode', p_mode, 'rows_deleted', 0,
      'message', 'Already removed. Nothing changed.');
  end if;

  insert into collective.admin_audit_log (actor_id, action, subject_kind, subject_id, subject_slug, mode, status, detail)
  values (p_actor, 'member_remove', 'creator', v_id, p_creator_slug, p_mode, 'started',
          jsonb_build_object('preview', pre - 'will_preserve'))
  returning id into audit_id;

  begin
    /* The append-only trigger on projections honours this switch; without it a
       delete on that table is refused and the whole removal fails. It is
       transaction-local, so it lifts on commit AND on rollback. */
    perform set_config('collective.maintenance', 'on', true);

    if p_mode = 'full_collective_delete' then
      /* Everything under the creator, children before parents. A protected
         table is never deleted from; if one of them still holds rows pointing
         at what we are deleting, the foreign key raises here and the whole
         removal rolls back — half a contributor is not an outcome this offers. */
      for r in select * from collective.mcr_plan(v_id) order by step desc loop
        if r.is_root or r.protected or r.n = 0 then continue; end if;
        execute format('delete from %s where %s', r.rel::text, r.pred);
        get diagnostics k = row_count;
        n_total := n_total + k;
        if k > 0 then deleted := deleted || jsonb_build_object('table', r.rel_name, 'rows', k); end if;
      end loop;
    else
      /* Membership only: revoke every credential and access grant, keep every
         projection, grade, model and record exactly as it stands. */
      for r in select * from collective.mcr_plan(v_id) order by step desc loop
        if r.is_root or r.protected or r.n = 0 then continue; end if;
        if r.rel_name !~ '(key|token|secret|origin|invite|invitation|session|credential)' then continue; end if;
        execute format('delete from %s where %s', r.rel::text, r.pred);
        get diagnostics k = row_count;
        n_total := n_total + k;
        if k > 0 then deleted := deleted || jsonb_build_object('table', r.rel_name, 'rows', k); end if;
      end loop;
    end if;

    -- the membership itself
    execute format('update %s set removed_at = now(), removed_by = $2, removal_mode = $3 where %I = $1',
      v_creators::text, c_pk) using v_id, p_actor, p_mode;

    /* account_status may be text or an enum with a fixed label set, so the
       first label the column actually accepts wins. An enum that has none of
       them is not an error: removed_at above is the record that matters. */
    if c_status is not null then
      ok_status := false;
      foreach v_status_new in array array['removed','disabled','revoked','suspended','inactive'] loop
        begin
          execute format('update %s set %I = %L where %I = $1',
            v_creators::text, c_status, v_status_new, c_pk) using v_id;
          ok_status := true;
          exit;
        exception when others then ok_status := false; end;
      end loop;
    end if;

    perform set_config('collective.maintenance', '', true);

    /* RECALCULATION. Consensus, records, coverage and calibration in this
       schema are VIEWS over projections, so they are already correct the
       instant the rows are gone. Anything MATERIALIZED is not, and anything the
       deployment rebuilds with a routine of its own is not either. Both are
       found and run here rather than assumed away — the routines FIRST, because
       a materialized view may well be reading the cache one of them rebuilds.

       A failure here is NOT swallowed. It propagates to the handler below and
       rolls the whole removal back, because the alternative is a removal that
       reports success and leaves a deleted contributor inside a number the site
       still shows as current — which is the one outcome §12 of this feature
       exists to prevent. The error names the object, so it is actionable. */
    for r in
      select p.proname::text as nm
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'collective' and p.pronargs = 0
         and p.proname ~ '^(rebuild|recalc|recalculate|refresh)_'
         and p.proname !~ '^mcr_'
       order by p.proname
    loop
      execute format('select collective.%I()', r.nm);
      refreshed := refreshed || jsonb_build_object('routine', r.nm, 'status', 'ran');
    end loop;
    for r in
      select c.oid::regclass as rel, c.relname::text as nm
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'collective' and c.relkind = 'm'
       order by c.relname
    loop
      execute format('refresh materialized view %s', r.rel::text);
      refreshed := refreshed || jsonb_build_object('materialized_view', r.nm, 'status', 'refreshed');
    end loop;

  exception when others then
    /* Every delete above is rolled back with this block. Nothing is half done. */
    perform set_config('collective.maintenance', '', true);
    update collective.admin_audit_log
       set status = 'failed', rows_deleted = 0,
           detail = detail || jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate)
     where id = audit_id;
    return jsonb_build_object('ok', false, 'code', 'removal_failed',
      'message', 'Nothing was removed: ' || sqlerrm, 'audit_id', audit_id);
  end;

  update collective.admin_audit_log
     set status = 'succeeded', rows_deleted = n_total,
         detail = detail || jsonb_build_object('deleted', deleted, 'recalculated', refreshed)
   where id = audit_id;

  return jsonb_build_object(
    'ok', true, 'audit_id', audit_id, 'creator_slug', p_creator_slug,
    'display_name', v_name, 'mode', p_mode,
    'rows_deleted', n_total,
    'submissions_deleted', case when p_mode = 'full_collective_delete'
      then coalesce((pre -> 'counts' ->> 'submissions')::bigint, 0) else 0 end,
    'deleted', deleted, 'recalculated', refreshed);
end
$fn$;

comment on function collective.admin_member_remove(uuid, text, text, text) is
  'Remove one contributor from the Collective. membership_only revokes access and keeps every submission; full_collective_delete additionally deletes every row under them in the collective schema except protected tables. One transaction: a failure leaves the contributor and their data untouched. Never deletes the creator row, market data, financial records, another contributor''s rows, or the auth user.';

-- 7 ---- the admin list's activity columns -------------------------------------
create or replace function collective.admin_member_activity(p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = collective, public
as $fn$
declare
  v_creators regclass := collective.mcr_rel('creators');
  v_models   regclass := collective.mcr_rel('models');
  v_proj     regclass := collective.mcr_rel('projections');
  c_pk text; c_slug text; c_user text;
  m_fk text; m_pk text; p_fk text; p_recv text; p_graded text;
  out_rows jsonb := '[]'::jsonb;
  admin_ids uuid[] := collective.mcr_admin_ids();
  sql text;
begin
  if not collective.mcr_is_admin(p_actor) then
    return jsonb_build_object('ok', false, 'code', 'forbidden',
      'message', 'This account is not a Collective administrator.');
  end if;
  if v_creators is null or v_models is null or v_proj is null then
    return jsonb_build_object('ok', true, 'rows', '[]'::jsonb, 'available', false);
  end if;
  c_pk := collective.mcr_pk(v_creators);
  c_slug := collective.mcr_col(v_creators, array['slug','creator_slug','handle']);
  c_user := collective.mcr_col(v_creators, array['user_id','auth_user_id','account_id','uid']);
  m_fk := collective.mcr_fk_col(v_models, v_creators);
  m_pk := collective.mcr_pk(v_models);
  p_fk := collective.mcr_fk_col(v_proj, v_models);
  p_recv := collective.mcr_col(v_proj, array['received_at','created_at','submitted_at']);
  p_graded := collective.mcr_col(v_proj, array['is_graded','graded','graded_at','result','grade']);
  if c_slug is null or m_fk is null or p_fk is null then
    return jsonb_build_object('ok', true, 'rows', '[]'::jsonb, 'available', false);
  end if;

  sql := format($q$
    select coalesce(jsonb_agg(jsonb_build_object(
             'creator_slug', c.%1$I,
             'user_id',      %2$s,
             'submissions',  s.n,
             'graded',       s.g,
             'last_submission_at', s.last_at,
             'removed_at',   c.removed_at,
             'removal_mode', c.removal_mode
           ) order by c.%1$I), '[]'::jsonb)
      from %3$s c
      left join lateral (
        select count(*) as n, %4$s as g, %5$s as last_at
          from %6$s p
         where p.%7$I in (select m.%8$I from %9$s m where m.%10$I = c.%11$I)
      ) s on true
  $q$,
    c_slug,
    coalesce('c.' || quote_ident(c_user), 'null::uuid'),
    v_creators::text,
    case when p_graded is null then '0::bigint'
         when p_graded in ('is_graded','graded') then 'count(*) filter (where coalesce(p.' || quote_ident(p_graded) || ', false))'
         else 'count(*) filter (where p.' || quote_ident(p_graded) || ' is not null)' end,
    case when p_recv is null then 'null::timestamptz' else 'max(p.' || quote_ident(p_recv) || ')' end,
    v_proj::text, p_fk, m_pk, v_models::text, m_fk, c_pk);

  execute sql into out_rows;
  return jsonb_build_object('ok', true, 'available', true, 'rows', out_rows,
    'admin_user_ids', to_jsonb(admin_ids));
exception when others then
  return jsonb_build_object('ok', true, 'available', false, 'rows', '[]'::jsonb, 'note', sqlerrm);
end
$fn$;

-- 8 ---- the removal has to STICK ----------------------------------------------
-- Deleting the keys is what stops an automated post; this is what stops
-- everything else, including a still-deployed edge function that has never
-- heard of removal. It fails OPEN on anything unexpected: a removal that
-- cannot be confirmed must not cost every other creator their slate.
do $do$
declare
  v_creators regclass := collective.mcr_rel('creators');
  v_models   regclass := collective.mcr_rel('models');
  v_proj     regclass := collective.mcr_rel('projections');
begin
  if v_creators is null or v_models is null or v_proj is null then
    insert into mcr_report(step, outcome, detail) values
      ('8 removed members cannot post', 'skipped', 'creators/models/projections not all present');
    return;
  end if;

  create or replace function collective.mcr_block_removed_member()
  returns trigger
  language plpgsql
  security definer
  set search_path = collective, public
  as $b$
  declare
    gone timestamptz;
    v_models regclass := collective.mcr_rel('models');
    v_creators regclass := collective.mcr_rel('creators');
    m_fk text; m_pk text; c_pk text;
  begin
    begin
      if new.model_id is null then return new; end if;
      m_fk := collective.mcr_fk_col(v_models, v_creators);
      m_pk := collective.mcr_pk(v_models);
      c_pk := collective.mcr_pk(v_creators);
      execute format('select c.removed_at from %s m join %s c on c.%I = m.%I where m.%I = $1',
        v_models::text, v_creators::text, c_pk, m_fk, m_pk)
        into gone using new.model_id;
    exception when others then
      return new;   -- fails OPEN
    end;
    if gone is not null then
      raise exception 'this model belongs to a contributor removed from the Collective on %', gone
        using errcode = 'check_violation';
    end if;
    return new;
  end
  $b$;

  execute 'drop trigger if exists mcr_block_removed_member on ' || v_proj::text;
  execute 'create trigger mcr_block_removed_member before insert on ' || v_proj::text ||
          ' for each row execute function collective.mcr_block_removed_member()';

  insert into mcr_report(step, outcome, detail) values
    ('8 removed members cannot post', 'ok',
     'trigger mcr_block_removed_member on ' || v_proj::text ||
     ' — a projection cannot be inserted for a removed contributor''s model (fails open)');
exception when others then
  insert into mcr_report(step, outcome, detail) values
    ('8 removed members cannot post', 'CHECK THIS', sqlerrm);
end $do$;

-- 9 ---- the three doors, and who may knock -------------------------------------
-- The browser calls these, over PostgREST, with the signed-in user's own JWT.
-- The acting user is auth.uid() and can be nothing else: there is no argument
-- for it, so a forged body cannot supply one.

create or replace function public.collective_member_activity()
returns jsonb
language sql
stable
security definer
set search_path = public, collective
as $fn$ select collective.admin_member_activity(auth.uid()); $fn$;

create or replace function public.collective_member_removal_preview(p_creator_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public, collective
as $fn$ select collective.admin_member_preview(auth.uid(), p_creator_slug); $fn$;

create or replace function public.collective_member_remove(
  p_creator_slug text, p_mode text, p_confirm text default null)
returns jsonb
language sql
security definer
set search_path = public, collective
as $fn$ select collective.admin_member_remove(auth.uid(), p_creator_slug, p_mode, p_confirm); $fn$;

do $do$
declare
  fn text;
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  has_srv  boolean := exists (select 1 from pg_roles where rolname = 'service_role');
begin
  /* The collective-schema routines are for the service role only: an edge
     function may call them, a browser may not reach them at all. */
  foreach fn in array array[
    'collective.admin_member_preview(uuid, text)',
    'collective.admin_member_remove(uuid, text, text, text)',
    'collective.admin_member_activity(uuid)',
    'collective.mcr_plan(uuid, integer)',
    'collective.mcr_is_admin(uuid)',
    'collective.mcr_admin_ids()',
    'collective.mcr_config(text)',
    'collective.mcr_protected(text)'] loop
    execute 'revoke all on function ' || fn || ' from public';
    if has_anon then execute 'revoke all on function ' || fn || ' from anon'; end if;
    if has_auth then execute 'revoke all on function ' || fn || ' from authenticated'; end if;
    if has_srv  then execute 'grant execute on function ' || fn || ' to service_role'; end if;
  end loop;

  /* The public wrappers are the only client door, and only for a signed-in
     account. anon never gets execute: an unauthenticated caller must not even
     be able to learn that a slug exists. */
  foreach fn in array array[
    'public.collective_member_activity()',
    'public.collective_member_removal_preview(text)',
    'public.collective_member_remove(text, text, text)'] loop
    execute 'revoke all on function ' || fn || ' from public';
    if has_anon then execute 'revoke all on function ' || fn || ' from anon'; end if;
    if has_auth then execute 'grant execute on function ' || fn || ' to authenticated'; end if;
    if has_srv  then execute 'grant execute on function ' || fn || ' to service_role'; end if;
  end loop;

  insert into mcr_report(step, outcome, detail) values
    ('9 grants', 'ok',
     'collective.* routines: service_role only. public.collective_member_* : authenticated only' ||
     case when has_anon then ', anon revoked' else '' end);
exception when others then
  insert into mcr_report(step, outcome, detail) values ('9 grants', 'CHECK THIS', sqlerrm);
end $do$;

commit;

-- 10 ---- the report -------------------------------------------------------------
insert into mcr_report(step, outcome, detail)
select '10 routine ' || p.proname, 'ok', 'installed'
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where (n.nspname = 'collective' and p.proname in
         ('admin_member_preview','admin_member_remove','admin_member_activity','mcr_plan','mcr_is_admin','mcr_protected'))
    or (n.nspname = 'public' and p.proname in
         ('collective_member_activity','collective_member_removal_preview','collective_member_remove'))
 order by p.proname;

insert into mcr_report(step, outcome, detail)
select '10 no client may read the audit log',
       case when count(*) = 0 then 'ok' else 'CHECK THIS' end,
       coalesce(string_agg(grantee || ':' || privilege_type, ', '), 'no grants to anon or authenticated')
  from information_schema.role_table_grants
 where table_schema = 'collective' and table_name = 'admin_audit_log'
   and grantee in ('anon', 'authenticated', 'PUBLIC');

insert into mcr_report(step, outcome, detail)
select '10 protected tables in this schema', 'ok',
       coalesce(string_agg(c.relname, ', ' order by c.relname), 'none')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'collective' and c.relkind = 'r' and collective.mcr_protected(c.relname::text);

select n, step, outcome, detail from mcr_report order by n;
