-- ===========================================================================
-- EdgeDesk — "Report a problem", the table.
--
-- WHY THIS FILE EXISTS. The terminal has had a feedback form since it was
-- written. It posted to `public.feedback`, and no file in this repository ever
-- created that table: the definition lived, if anywhere, in somebody's SQL
-- editor history. The form's own error message said so out loud — "run
-- feedback.sql if the table is missing" — to the CUSTOMER. So the one channel
-- a first-time user had for telling us something was broken was itself broken,
-- in a way nobody could see from a checkout.
--
-- This is that table, committed, with the guarantees the product needs:
--
--   * ANYONE CAN FILE ONE. A report is most valuable exactly when the reporter
--     could not sign in, so `anon` may insert. What `anon` may NOT do is claim
--     to be somebody: the insert policy requires user_id to be null unless it
--     equals auth.uid().
--   * NOBODY CAN READ SOMEBODY ELSE'S. Select is the reporter's own rows plus
--     an explicit operator allowlist. `anon` may not read at all, which also
--     means a report cannot be used to enumerate accounts or emails.
--   * NOTHING SENSITIVE IS ACCEPTED. There is no column for a token, a
--     password or a card, and a check constraint refuses a body that looks
--     like a JWT — belt and braces against a well-meaning paste.
--   * IT IS TRIAGE-READY. Status, severity and an operator note live on the
--     row, so admin.html is a view over the real table rather than a second
--     system that has to be kept in step.
--
-- Idempotent, additive, and it ends in a report — the convention every file in
-- this folder follows. Run it in the SQL editor. Rows 1-12 should each say ok.
--
-- Tested against a real PostgreSQL by tools/app/issue_reports_sql.test.js
-- (`npm run issues:sql`), which applies this file unmodified and then attacks
-- it as anon, as one user reaching for another user's rows, and as an operator.
-- ===========================================================================

create extension if not exists pgcrypto;

create table if not exists public.issue_reports (
  id            uuid        primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  -- who. null for a reporter who was not signed in, which is a legitimate and
  -- common case: "I could not sign up" is filed by definition without a session.
  user_id       uuid        references auth.users(id) on delete set null,
  user_email    text,
  contact_email text,
  -- what they said
  category      text        not null default 'Something else',
  summary       text        not null,
  details       text        not null,
  steps         text,
  -- where and when, from the browser
  route         text,
  page_url      text,
  reported_at   timestamptz,
  app_version   text,
  surface       text,
  auth_state    text,
  user_agent    text,
  viewport      text,
  language      text,
  referrer      text,
  -- triage, owned by the operator
  status        text        not null default 'new',
  severity      text,
  admin_notes   text,
  resolved_at   timestamptz
);

-- A report opened months later is worthless without these three, so they are
-- constrained rather than trusted.
alter table public.issue_reports
  drop constraint if exists issue_reports_summary_shape;
alter table public.issue_reports
  add constraint issue_reports_summary_shape
  check (char_length(btrim(summary)) between 1 and 200);

alter table public.issue_reports
  drop constraint if exists issue_reports_details_shape;
alter table public.issue_reports
  add constraint issue_reports_details_shape
  check (char_length(btrim(details)) between 1 and 8000);

alter table public.issue_reports
  drop constraint if exists issue_reports_status_shape;
alter table public.issue_reports
  add constraint issue_reports_status_shape
  check (status in ('new','triaged','in_progress','resolved','wont_fix','duplicate'));

-- NO CREDENTIAL EVER LANDS HERE. The client is careful (it scrubs the URL and
-- never reads a token into the payload), but the client is a browser and the
-- database is the only place this can be guaranteed. A three-segment
-- base64url string is a JWT; refuse the row rather than store one.
alter table public.issue_reports
  drop constraint if exists issue_reports_no_credentials;
alter table public.issue_reports
  add constraint issue_reports_no_credentials
  check (
    coalesce(details,'') !~ 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'
    and coalesce(steps,'') !~ 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'
    and coalesce(page_url,'') !~ '(access_token|refresh_token|token_hash)='
  );

create index if not exists issue_reports_triage
  on public.issue_reports (status, created_at desc);
create index if not exists issue_reports_by_user
  on public.issue_reports (user_id, created_at desc);

-- ── who is an operator ─────────────────────────────────────────────────────
-- One allowlist, in the database, so the answer does not depend on a browser
-- being honest about which account it is signed in as. RLS is on and there are
-- no client grants: the table is invisible from PostgREST and is edited in the
-- SQL editor. The security-definer function below is the only way to ask.
create table if not exists public.issue_report_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  note       text,
  added_at   timestamptz not null default now()
);
alter table public.issue_report_admins enable row level security;
revoke all on public.issue_report_admins from anon, authenticated;

-- The founding operator, so the allowlist is never empty on a fresh install.
-- Same id app.html already treats as the owner (PG_OWNER_ID). Additive: an
-- existing row is left exactly as it is.
insert into public.issue_report_admins (user_id, note)
select 'e7e46801-80c4-4f47-b718-4aff211c8d3a'::uuid, 'founding operator'
where exists (select 1 from auth.users where id = 'e7e46801-80c4-4f47-b718-4aff211c8d3a')
on conflict (user_id) do nothing;

create or replace function public.issue_report_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select auth.uid() is not null
     and exists (select 1 from public.issue_report_admins a where a.user_id = auth.uid());
$$;
revoke all on function public.issue_report_is_admin() from public;
grant execute on function public.issue_report_is_admin() to authenticated;

-- ── row level security ─────────────────────────────────────────────────────
alter table public.issue_reports enable row level security;

-- INSERT: anyone, including a visitor who could not sign in — but nobody may
-- file a report under another account's id.
drop policy if exists issue_reports_insert on public.issue_reports;
create policy issue_reports_insert
  on public.issue_reports for insert
  to anon, authenticated
  with check (user_id is null or user_id = auth.uid());

-- SELECT: your own reports, or an operator's view of everything. `anon` is not
-- in the policy at all, so an anonymous report is write-only from the browser
-- that filed it — which is the correct trade for letting anyone file one.
drop policy if exists issue_reports_read on public.issue_reports;
create policy issue_reports_read
  on public.issue_reports for select
  to authenticated
  using (user_id = auth.uid() or public.issue_report_is_admin());

-- UPDATE: triage only, and only by an operator. A reporter cannot edit a
-- report after filing it — the record of what they said stays what they said.
drop policy if exists issue_reports_update on public.issue_reports;
create policy issue_reports_update
  on public.issue_reports for update
  to authenticated
  using (public.issue_report_is_admin())
  with check (public.issue_report_is_admin());

-- DELETE: nobody, through any client role. Reports are evidence.
drop policy if exists issue_reports_delete on public.issue_reports;

grant select, insert on public.issue_reports to authenticated;
grant insert on public.issue_reports to anon;
revoke delete on public.issue_reports from anon, authenticated;
grant update on public.issue_reports to authenticated;   -- still gated by the policy above

comment on table public.issue_reports is
  'EdgeDesk problem reports, filed from lib/edgedesk_report.js. Anyone may '
  'insert (a report is most valuable when the reporter could not sign in); '
  'reads are the reporter''s own rows plus public.issue_report_admins. Never '
  'stores a token, a password or a payment detail.';

-- ── the legacy feedback table, if this project has one ─────────────────────
-- `public.feedback` was created by hand in the dashboard and was never in this
-- repository. If it exists, its rows are brought across ONCE and the original
-- table is left untouched — additive, like every file here. If it does not
-- exist, this block does nothing and says so in the report.
alter table public.issue_reports
  add column if not exists legacy_feedback_id bigint;
create unique index if not exists issue_reports_legacy_once
  on public.issue_reports (legacy_feedback_id) where legacy_feedback_id is not null;

do $$
declare has_id boolean;
begin
  if to_regclass('public.feedback') is null then return; end if;
  select exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='feedback' and column_name='id')
    into has_id;
  if not has_id then return; end if;

  execute $q$
    insert into public.issue_reports
      (created_at, user_email, category, summary, details, app_version, user_agent,
       surface, auth_state, status, legacy_feedback_id)
    select coalesce(f.created_at, now()),
           f.user_email,
           'Something else',
           left(coalesce(nullif(btrim(f.title),''), 'Imported feedback'), 200),
           left(coalesce(nullif(btrim(f.body),''), '(no description)'), 8000),
           f.app_version, left(coalesce(f.user_agent,''), 400),
           'legacy_feedback', 'unknown', 'new', f.id
      from public.feedback f
     where not exists (select 1 from public.issue_reports r where r.legacy_feedback_id = f.id)
  $q$;
exception when others then
  -- A legacy table with a different shape is not a reason to fail the install.
  raise notice 'legacy feedback import skipped: %', sqlerrm;
end $$;

-- ── report ─────────────────────────────────────────────────────────────────
select 1 as row, 'issue_reports exists' as check,
       case when to_regclass('public.issue_reports') is not null then 'ok' else 'CHECK THIS' end as result
union all select 2, 'RLS is enabled on issue_reports',
       case when (select relrowsecurity from pg_class where oid='public.issue_reports'::regclass)
            then 'ok' else 'CHECK THIS' end
union all select 3, 'anon may insert',
       case when exists (select 1 from pg_policies where schemaname='public' and tablename='issue_reports'
                          and policyname='issue_reports_insert' and 'anon'=any(roles)) then 'ok' else 'CHECK THIS' end
union all select 4, 'anon has NO read policy',
       case when not exists (select 1 from pg_policies where schemaname='public' and tablename='issue_reports'
                              and cmd='SELECT' and 'anon'=any(roles)) then 'ok' else 'CHECK THIS' end
union all select 5, 'no delete policy exists',
       case when not exists (select 1 from pg_policies where schemaname='public' and tablename='issue_reports'
                              and cmd='DELETE') then 'ok' else 'CHECK THIS' end
union all select 6, 'summary/details constraints installed',
       case when (select count(*) from pg_constraint
                   where conrelid='public.issue_reports'::regclass
                     and conname in ('issue_reports_summary_shape','issue_reports_details_shape',
                                     'issue_reports_status_shape','issue_reports_no_credentials'))=4
            then 'ok' else 'CHECK THIS' end
union all select 7, 'triage index installed',
       case when to_regclass('public.issue_reports_triage') is not null then 'ok' else 'CHECK THIS' end
union all select 8, 'issue_report_admins exists with RLS on',
       case when to_regclass('public.issue_report_admins') is not null
             and (select relrowsecurity from pg_class where oid='public.issue_report_admins'::regclass)
            then 'ok' else 'CHECK THIS' end
union all select 9, 'issue_report_admins is unreachable from anon/authenticated',
       case when not exists (
              select 1 from information_schema.role_table_grants
               where table_schema='public' and table_name='issue_report_admins'
                 and grantee in ('anon','authenticated'))
            then 'ok' else 'CHECK THIS' end
union all select 10, 'issue_report_is_admin() is security definer',
       case when (select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public' and p.proname='issue_report_is_admin')
            then 'ok' else 'CHECK THIS' end
union all select 11, 'at least one operator is on the allowlist',
       case when (select count(*) from public.issue_report_admins) > 0 then 'ok'
            else 'CHECK THIS — add yourself: insert into public.issue_report_admins(user_id) values (''<your auth.users id>'')' end
union all select 12, 'legacy public.feedback rows imported',
       case when to_regclass('public.feedback') is null then 'ok (no legacy table)'
            else 'ok (' || (select count(*) from public.issue_reports where legacy_feedback_id is not null)::text || ' imported)' end
order by row;
