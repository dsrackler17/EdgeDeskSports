-- portfolio -- part 8 of 9.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. SYNC LOGS, AND THE OPERATOR'S VIEW OF THEM
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.portfolio_sync_logs (
  id                  bigint      generated always as identity primary key,
  user_id             uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  platform_account_id uuid        null,
  platform            text        null,
  sync_kind           text        not null,
  import_id           uuid        null,
  status              text        not null default 'RUNNING',
  started_at          timestamptz not null default now(),
  completed_at        timestamptz null,
  duration_ms         bigint      generated always as ((extract(epoch from (completed_at - started_at)) * 1000)::bigint) stored,
  records_fetched     int         not null default 0,
  records_inserted    int         not null default 0,
  records_updated     int         not null default 0,
  duplicates_ignored  int         not null default 0,
  errors_count        int         not null default 0,
  error_code          text        null,
  error_summary       text        null,
  attempt             int         not null default 1,
  created_at          timestamptz not null default now(),
  constraint portfolio_sync_logs_account_fk foreign key (platform_account_id, user_id)
    references public.platform_accounts (id, user_id) on delete set null (platform_account_id),
  constraint portfolio_sync_logs_import_fk foreign key (import_id, user_id)
    references public.portfolio_imports (id, user_id) on delete set null (import_id),
  constraint portfolio_sync_logs_kind check (sync_kind in ('CSV_IMPORT', 'MANUAL', 'API_SYNC', 'WEBHOOK', 'HEALTH_CHECK', 'CONNECT', 'DISCONNECT')),
  constraint portfolio_sync_logs_status check (status in ('RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED')),
  constraint portfolio_sync_logs_counts check (records_fetched >= 0 and records_inserted >= 0 and records_updated >= 0
    and duplicates_ignored >= 0 and errors_count >= 0 and attempt between 1 and 100),
  -- an error is a code and a short sanitized sentence: never a response body,
  -- a header or a token
  constraint portfolio_sync_logs_error check ((error_code is null or error_code ~ '^[A-Z0-9_]{1,40}$')
    and (error_summary is null or length(error_summary) <= 500))
);
create index if not exists portfolio_sync_logs_user on public.portfolio_sync_logs (user_id, started_at desc);
create index if not exists portfolio_sync_logs_recent on public.portfolio_sync_logs (started_at desc);

-- Counts by platform, kind and outcome. No user id, no account id, no error
-- text, no credential: what an operator needs to see that a connector is
-- failing, and nothing about whose account it is failing on.
create or replace function public.portfolio_admin_sync_health(p_days int default 7)
returns table (platform text, sync_kind text, status text, runs bigint, accounts bigint, records_inserted bigint,
               duplicates_ignored bigint, errors bigint, p50_ms double precision, p95_ms double precision, top_error_code text, last_run timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare ok boolean := false;
begin
  if to_regprocedure('public.billing_is_admin()') is not null then execute 'select public.billing_is_admin()' into ok; end if;
  if not coalesce(ok, false) then raise exception 'portfolio: operators only' using errcode = '42501'; end if;
  return query
    select coalesce(l.platform, '(none)'), l.sync_kind, l.status, count(*), count(distinct l.platform_account_id),
           sum(l.records_inserted)::bigint, sum(l.duplicates_ignored)::bigint, sum(l.errors_count)::bigint,
           percentile_cont(0.5) within group (order by l.duration_ms), percentile_cont(0.95) within group (order by l.duration_ms),
           mode() within group (order by l.error_code), max(l.started_at)
      from public.portfolio_sync_logs l
     where l.started_at >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 7), 90)))
     group by 1, 2, 3 order by 1, 2, 3;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. CREDENTIALS — ciphertext only, in a schema the API never serves
-- ─────────────────────────────────────────────────────────────────────────────
-- Phase A stores nothing here. Phase B's connect function encrypts (AES-GCM,
-- key held in Edge Function secrets, key_version for rotation) before
-- writing, and decrypts only inside the sync function. Neither the browser nor
-- any reader role can see this schema.
create schema if not exists portfolio_private;
revoke all on schema portfolio_private from public;
do $$ begin
  execute 'revoke all on schema portfolio_private from anon, authenticated';
  execute 'grant usage on schema portfolio_private to service_role';
end $$;
create table if not exists portfolio_private.platform_credentials (
  id                  uuid        primary key default gen_random_uuid(),
  platform_account_id uuid        not null,
  user_id             uuid        not null references auth.users(id) on delete cascade,
  credential_kind     text        not null,
  ciphertext          bytea       not null,
  nonce               bytea       not null,
  key_version         int         not null,
  key_hint            text        null,
  scopes              text[]      null,
  expires_at          timestamptz null,
  rotated_at          timestamptz null,
  revoked_at          timestamptz null,
  last_used_at        timestamptz null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint platform_credentials_account_fk foreign key (platform_account_id, user_id)
    references public.platform_accounts (id, user_id) on delete cascade,
  constraint platform_credentials_one_per_account unique (platform_account_id),
  constraint platform_credentials_kind check (credential_kind in ('API_KEY', 'OAUTH_TOKENS', 'AGGREGATOR_TOKEN', 'WALLET_ADDRESS')),
  constraint platform_credentials_shape check (key_version > 0 and length(nonce) between 12 and 32
    and length(ciphertext) between 16 and 16384 and (key_hint is null or length(key_hint) <= 8))
);
alter table portfolio_private.platform_credentials enable row level security;
revoke all on portfolio_private.platform_credentials from public;
do $$ begin
  execute 'revoke all on portfolio_private.platform_credentials from anon, authenticated';
  execute 'grant select, insert, update, delete on portfolio_private.platform_credentials to service_role';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. THE READ SIDE, ROW LEVEL SECURITY AND GRANTS
-- ─────────────────────────────────────────────────────────────────────────────
-- security_invoker: a view runs as its owner otherwise, and would read every
-- reader's rows regardless of who asked.
create or replace view public.portfolio_account_summary with (security_invoker = true) as
select a.id, a.user_id, a.platform, a.platform_label, a.platform_type, a.connection_type, a.display_name, a.status,
       a.last_sync_at, a.last_success_at, a.last_error, a.created_at,
       count(p.id) as positions,
       count(p.id) filter (where p.status = 'OPEN') as open_positions,
       count(p.id) filter (where p.status <> 'OPEN') as settled_positions,
       max(p.placed_at) as last_position_at,
       (select max(i.committed_at) from public.portfolio_imports i where i.platform_account_id = a.id) as last_import_at
  from public.platform_accounts a
  left join public.portfolio_positions p on p.platform_account_id = a.id
 group by a.id;

alter table public.platform_accounts enable row level security;
alter table public.portfolio_positions enable row level security;
alter table public.portfolio_transactions enable row level security;
alter table public.portfolio_imports enable row level security;
alter table public.portfolio_import_rows enable row level security;
alter table public.portfolio_sync_logs enable row level security;

drop policy if exists platform_accounts_select_own on public.platform_accounts;
create policy platform_accounts_select_own on public.platform_accounts for select to authenticated using (user_id = auth.uid());
drop policy if exists platform_accounts_insert_own on public.platform_accounts;
create policy platform_accounts_insert_own on public.platform_accounts for insert to authenticated
  with check (user_id = auth.uid() and connection_type in ('MANUAL', 'CSV'));
drop policy if exists platform_accounts_update_own on public.platform_accounts;
create policy platform_accounts_update_own on public.platform_accounts for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists platform_accounts_delete_own on public.platform_accounts;
create policy platform_accounts_delete_own on public.platform_accounts for delete to authenticated using (user_id = auth.uid());

drop policy if exists portfolio_positions_select_own on public.portfolio_positions;
create policy portfolio_positions_select_own on public.portfolio_positions for select to authenticated using (user_id = auth.uid());
drop policy if exists portfolio_positions_insert_own on public.portfolio_positions;
create policy portfolio_positions_insert_own on public.portfolio_positions for insert to authenticated
  with check (user_id = auth.uid() and source in ('MANUAL', 'CSV', 'EDGEDESK'));
drop policy if exists portfolio_positions_update_own on public.portfolio_positions;
create policy portfolio_positions_update_own on public.portfolio_positions for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists portfolio_positions_delete_own on public.portfolio_positions;
create policy portfolio_positions_delete_own on public.portfolio_positions for delete to authenticated
  using (user_id = auth.uid() and source <> 'SYNC');

drop policy if exists portfolio_transactions_select_own on public.portfolio_transactions;
create policy portfolio_transactions_select_own on public.portfolio_transactions for select to authenticated using (user_id = auth.uid());
drop policy if exists portfolio_transactions_insert_own on public.portfolio_transactions;
create policy portfolio_transactions_insert_own on public.portfolio_transactions for insert to authenticated
  with check (user_id = auth.uid() and source in ('MANUAL', 'CSV', 'EDGEDESK'));
drop policy if exists portfolio_transactions_update_own on public.portfolio_transactions;
create policy portfolio_transactions_update_own on public.portfolio_transactions for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists portfolio_transactions_delete_own on public.portfolio_transactions;
create policy portfolio_transactions_delete_own on public.portfolio_transactions for delete to authenticated
  using (user_id = auth.uid() and source <> 'SYNC');

drop policy if exists portfolio_imports_select_own on public.portfolio_imports;
create policy portfolio_imports_select_own on public.portfolio_imports for select to authenticated using (user_id = auth.uid());
drop policy if exists portfolio_imports_insert_own on public.portfolio_imports;
create policy portfolio_imports_insert_own on public.portfolio_imports for insert to authenticated with check (user_id = auth.uid());
drop policy if exists portfolio_imports_update_own on public.portfolio_imports;
create policy portfolio_imports_update_own on public.portfolio_imports for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists portfolio_imports_delete_own on public.portfolio_imports;
create policy portfolio_imports_delete_own on public.portfolio_imports for delete to authenticated using (user_id = auth.uid());

drop policy if exists portfolio_import_rows_select_own on public.portfolio_import_rows;
create policy portfolio_import_rows_select_own on public.portfolio_import_rows for select to authenticated using (user_id = auth.uid());
drop policy if exists portfolio_import_rows_insert_own on public.portfolio_import_rows;
create policy portfolio_import_rows_insert_own on public.portfolio_import_rows for insert to authenticated with check (user_id = auth.uid());
drop policy if exists portfolio_import_rows_update_own on public.portfolio_import_rows;
create policy portfolio_import_rows_update_own on public.portfolio_import_rows for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists portfolio_import_rows_delete_own on public.portfolio_import_rows;
create policy portfolio_import_rows_delete_own on public.portfolio_import_rows for delete to authenticated using (user_id = auth.uid());

drop policy if exists portfolio_sync_logs_select_own on public.portfolio_sync_logs;
create policy portfolio_sync_logs_select_own on public.portfolio_sync_logs for select to authenticated using (user_id = auth.uid());
drop policy if exists portfolio_sync_logs_insert_own on public.portfolio_sync_logs;
create policy portfolio_sync_logs_insert_own on public.portfolio_sync_logs for insert to authenticated
  with check (user_id = auth.uid() and sync_kind in ('CSV_IMPORT', 'MANUAL'));

-- Grants. Supabase grants every new public table to anon and authenticated;
-- these narrow it. anon gets nothing at all. Readers may rename an account
-- but never touch its connection state; logs are append-only for readers.
revoke all on public.platform_accounts, public.portfolio_positions, public.portfolio_transactions, public.portfolio_imports,
  public.portfolio_import_rows, public.portfolio_sync_logs, public.portfolio_account_summary from anon;
revoke all on public.platform_accounts, public.portfolio_sync_logs from authenticated;
grant select, insert, delete on public.platform_accounts to authenticated;
grant update (display_name, platform_label) on public.platform_accounts to authenticated;
grant select, insert, update, delete on public.portfolio_positions, public.portfolio_transactions, public.portfolio_imports,
  public.portfolio_import_rows to authenticated;
grant select, insert on public.portfolio_sync_logs to authenticated;
grant select on public.portfolio_account_summary to authenticated;
grant usage, select on sequence public.portfolio_import_rows_id_seq, public.portfolio_sync_logs_id_seq to authenticated;
grant select, insert, update, delete on public.platform_accounts, public.portfolio_positions, public.portfolio_transactions,
  public.portfolio_imports, public.portfolio_import_rows, public.portfolio_sync_logs to service_role;
grant select on public.portfolio_account_summary to service_role;
grant usage, select on sequence public.portfolio_import_rows_id_seq, public.portfolio_sync_logs_id_seq to service_role;

-- Functions: nothing for anon; readers get the arithmetic, the fingerprints
-- and the three entry points; the operator view checks its caller itself.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace s on s.oid = p.pronamespace
            where s.nspname = 'public' and (p.proname like 'portfolio\_%' or p.proname = 'platform_accounts_guard')
              -- a connector's service-only entry points (portfolio_connect.sql) stay the service role's
              and p.proname not like 'portfolio\_svc\_%' loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('revoke all on function %s from anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
end $$;

notify pgrst, 'reload schema';
