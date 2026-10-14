-- portfolio_aggregator -- part 2 of 5.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- What the aggregator's API says about a linked account now (verified,
-- access, paused, the book, the latest refresh): kept on the account for the
-- reader and the operator to see. Never a credential; never from a webhook.
create or replace function public.portfolio_svc_ag_account_state(p_account uuid, p_detail jsonb)
returns void language plpgsql set search_path = public, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  if jsonb_typeof(p_detail) is distinct from 'object' or pg_column_size(p_detail) > 4096 then
    raise exception 'portfolio: the provider state must be a small object' using errcode = '22023';
  end if;
  update public.platform_accounts set metadata = metadata || jsonb_build_object('provider_state', p_detail, 'provider_state_at', now())
   where id = p_account and connection_type = 'AGGREGATOR';
  if not found then raise exception 'portfolio: no such linked account' using errcode = 'P0002'; end if;
end $$;

-- The reader's linked accounts at one provider and environment (for a
-- discovery pass to compare with the aggregator's list).
create or replace function public.portfolio_svc_ag_accounts(p_provider text, p_env text, p_user uuid)
returns jsonb language plpgsql stable set search_path = public, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  return (select coalesce(jsonb_agg(jsonb_build_object('account_id', a.id, 'external_account_id', a.external_account_id, 'platform', a.platform,
            'status', a.status, 'last_success_at', a.last_success_at, 'sync_cursor', a.sync_cursor) order by a.created_at), '[]'::jsonb)
    from public.platform_accounts a
   where a.user_id = p_user and a.connection_type = 'AGGREGATOR' and a.metadata->>'provider' = p_provider and a.metadata->>'environment' = p_env);
end $$;

-- What the scheduler should do now at one provider and environment: linked
-- accounts that are due (a webhook makes one due at once — even one waiting
-- on the reader, so a relink that worked is noticed), and bettors whose
-- account list should be re-read. Production returns nothing while the
-- registry has the provider switched off.
create or replace function public.portfolio_svc_ag_due(p_provider text, p_env text, p_limit int default 10)
returns table (kind text, account_id uuid, user_id uuid, platform text, external_account_id text, sync_cursor text, status text, has_run boolean,
               internal_id text, provider_bettor_id text)
language plpgsql stable set search_path = public, portfolio_private, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  if not public.portfolio_svc_ag_allowed(p_provider, p_env, null) then return; end if;
  return query
  (select 'ACCOUNT'::text, a.id, a.user_id, a.platform, a.external_account_id, a.sync_cursor, a.status,
          exists (select 1 from public.portfolio_sync_runs r where r.platform_account_id = a.id and r.status in ('SUCCEEDED', 'PARTIAL')),
          b.internal_id, b.provider_bettor_id
     from public.platform_accounts a
     left join portfolio_private.aggregator_bettors b on b.user_id = a.user_id and b.provider = p_provider and b.environment = p_env
    where a.connection_type = 'AGGREGATOR' and a.metadata->>'provider' = p_provider and a.metadata->>'environment' = p_env
      and a.status in ('CONNECTED', 'SYNCING', 'ERROR', 'ACTION_REQUIRED') and a.next_sync_at is not null and a.next_sync_at <= now()
      and not exists (select 1 from public.portfolio_sync_runs r where r.platform_account_id = a.id and r.status = 'RUNNING' and r.started_at > now() - interval '15 minutes')
    order by a.next_sync_at limit greatest(1, least(p_limit, 200)))
  union all
  (select 'BETTOR'::text, null::uuid, b.user_id, null::text, null::text, null::text, null::text, false, b.internal_id, b.provider_bettor_id
     from portfolio_private.aggregator_bettors b
    where b.provider = p_provider and b.environment = p_env and b.discover_at is not null and b.discover_at <= now()
    order by b.discover_at limit greatest(1, least(p_limit, 200)));
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. WEBHOOK DELIVERIES — recorded once, applied as hints
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists portfolio_private.aggregator_webhook_events (
  id               bigserial   primary key,
  provider         text        not null,
  environment      text        not null,
  dedupe_key       text        not null,
  event_type       text        not null,
  authenticated_by text        not null,
  refs             jsonb       not null default '{}'::jsonb,
  payload          jsonb       null,
  status           text        not null default 'RECEIVED',
  attempts         int         not null default 1,
  received_at      timestamptz not null default now(),
  last_received_at timestamptz not null default now(),
  processed_at     timestamptz null,
  accounts_marked  int         not null default 0,
  bettors_marked   int         not null default 0,
  error_code       text        null,
  error_message    text        null,
  constraint aggregator_webhook_once unique (provider, environment, dedupe_key),
  constraint aggregator_webhook_env check (environment in ('sandbox', 'production')),
  constraint aggregator_webhook_status check (status in ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED')),
  constraint aggregator_webhook_auth check (authenticated_by in ('SIGNATURE', 'FETCH_BACK')),
  constraint aggregator_webhook_text check (length(provider) <= 40 and length(dedupe_key) between 8 and 200 and length(event_type) between 1 and 80
    and coalesce(length(error_code), 0) <= 40 and coalesce(length(error_message), 0) <= 500),
  constraint aggregator_webhook_json check (jsonb_typeof(refs) = 'object' and pg_column_size(refs) <= 4096
    and (payload is null or pg_column_size(payload) <= 32768))
);
create index if not exists aggregator_webhook_recent on portfolio_private.aggregator_webhook_events (received_at desc);
alter table portfolio_private.aggregator_webhook_events enable row level security;
-- which request header carried a valid signature: the operator reads it from
-- the first genuine delivery and pins it (supabase/functions/sharpsports-webhook)
alter table portfolio_private.aggregator_webhook_events add column if not exists signature_header text null;
alter table portfolio_private.aggregator_webhook_events add column if not exists subscription_id text null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'aggregator_webhook_sig_text') then
    alter table portfolio_private.aggregator_webhook_events add constraint aggregator_webhook_sig_text
      check (coalesce(length(signature_header), 0) <= 60 and coalesce(length(subscription_id), 0) <= 80);
  end if;
end $$;

create table if not exists portfolio_private.aggregator_webhook_rejections (
  id        bigserial   primary key,
  provider  text        not null,
  reason    text        not null,
  at        timestamptz not null default now(),
  constraint aggregator_rejection_text check (length(provider) <= 40 and length(reason) <= 40)
);
create index if not exists aggregator_rejections_at on portfolio_private.aggregator_webhook_rejections (at desc);
alter table portfolio_private.aggregator_webhook_rejections enable row level security;

-- Record a delivery. A repeat of one already PROCESSED or IGNORED is a
-- duplicate (answered, not applied again); a repeat of one that FAILED, or
-- is still RECEIVED, is applied again — that is what the provider's retry is for.
create or replace function public.portfolio_svc_ag_webhook_record(p_provider text, p_env text, p_dedupe_key text, p_event_type text,
    p_authenticated_by text, p_refs jsonb default '{}'::jsonb, p_payload jsonb default null, p_signature_header text default null,
    p_subscription_id text default null)
returns jsonb language plpgsql set search_path = public, portfolio_private, pg_temp as $$
declare r record;
begin
  perform public.portfolio_svc_assert();
  insert into portfolio_private.aggregator_webhook_events (provider, environment, dedupe_key, event_type, authenticated_by, refs, payload,
      signature_header, subscription_id)
  values (p_provider, p_env, p_dedupe_key, left(coalesce(nullif(btrim(p_event_type), ''), 'unknown'), 80), p_authenticated_by,
          coalesce(case when jsonb_typeof(p_refs) = 'object' then p_refs end, '{}'::jsonb), p_payload, left(p_signature_header, 60), left(p_subscription_id, 80))
  on conflict (provider, environment, dedupe_key) do update set attempts = aggregator_webhook_events.attempts + 1, last_received_at = now()
  returning id, status, attempts into r;
  return jsonb_build_object('event_id', r.id, 'duplicate', r.attempts > 1 and r.status in ('PROCESSED', 'IGNORED'), 'status', r.status, 'attempts', r.attempts);
end $$;

-- Apply a delivery: make the accounts and bettors it names due NOW. Nothing
-- from the payload is stored on them; the sync re-reads the aggregator.
-- A delivery naming nothing EdgeDesk holds is IGNORED (answered 200: the
-- provider must not retry it).
create or replace function public.portfolio_svc_ag_webhook_apply(p_event bigint)
returns jsonb language plpgsql set search_path = public, portfolio_private, pg_temp as $$
declare e record; accts text[]; bettors text[]; internals text[]; n_acct int := 0; n_bettor int := 0; st text;
begin
  perform public.portfolio_svc_assert();
  select * into e from portfolio_private.aggregator_webhook_events where id = p_event for update;
  if not found then raise exception 'portfolio: no such delivery' using errcode = 'P0002'; end if;
  select array_agg(distinct v) into accts from jsonb_array_elements_text(case when jsonb_typeof(e.refs->'bettor_account_ids') = 'array'
    then e.refs->'bettor_account_ids' else '[]'::jsonb end) v where length(v) between 1 and 200;
  select array_agg(distinct v) into bettors from jsonb_array_elements_text(case when jsonb_typeof(e.refs->'bettor_ids') = 'array'
    then e.refs->'bettor_ids' else '[]'::jsonb end) v where length(v) between 1 and 120;
  select array_agg(distinct v) into internals from jsonb_array_elements_text(case when jsonb_typeof(e.refs->'internal_ids') = 'array'
    then e.refs->'internal_ids' else '[]'::jsonb end) v where length(v) between 8 and 64;
  if accts is not null then
    -- at most once a minute per account, however often the provider calls
    update public.platform_accounts a set next_sync_at = greatest(now(), coalesce(a.last_sync_at, now() - interval '1 minute') + interval '1 minute')
     where a.connection_type = 'AGGREGATOR' and a.metadata->>'provider' = e.provider and a.metadata->>'environment' = e.environment
       and a.external_account_id = any (accts) and a.status <> 'DISCONNECTED';
    get diagnostics n_acct = row_count;
  end if;
  if bettors is not null or internals is not null then
    -- a bettor named by the delivery: list its accounts again (a new link,
    -- a relink, an account the reader added on the aggregator's page)
    update portfolio_private.aggregator_bettors b set discover_at = now()
     where b.provider = e.provider and b.environment = e.environment
       and (b.provider_bettor_id = any (coalesce(bettors, '{}')) or b.internal_id = any (coalesce(internals, '{}')));
    get diagnostics n_bettor = row_count;
  end if;
  st := case when n_acct + n_bettor > 0 then 'PROCESSED' else 'IGNORED' end;
  update portfolio_private.aggregator_webhook_events set status = st, processed_at = now(), accounts_marked = n_acct, bettors_marked = n_bettor,
         error_code = case when st = 'IGNORED' then 'UNKNOWN_REFERENCE' end, error_message = null
   where id = p_event;
  return jsonb_build_object('status', st, 'accounts_marked', n_acct, 'bettors_marked', n_bettor);
end $$;

create or replace function public.portfolio_svc_ag_webhook_finish(p_event bigint, p_status text, p_error_code text default null, p_error_message text default null)
returns void language plpgsql set search_path = public, portfolio_private, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  update portfolio_private.aggregator_webhook_events set status = p_status, processed_at = now(), error_code = left(p_error_code, 40),
         error_message = left(p_error_message, 500)
   where id = p_event;
end $$;

-- A refused delivery: counted, nothing of it kept.
create or replace function public.portfolio_svc_ag_webhook_reject(p_provider text, p_reason text)
returns void language plpgsql set search_path = public, portfolio_private, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  insert into portfolio_private.aggregator_webhook_rejections (provider, reason) values (left(p_provider, 40), left(p_reason, 40));
end $$;

-- Old deliveries go: processed or ignored ones after p_days, rejections
-- after p_days. A FAILED delivery is kept until an operator has seen it.
create or replace function public.portfolio_svc_ag_prune(p_days int default 90)
returns jsonb language plpgsql set search_path = public, portfolio_private, pg_temp as $$
declare d int := greatest(7, least(coalesce(p_days, 90), 3650)); n1 int; n2 int;
begin
  perform public.portfolio_svc_assert();
  delete from portfolio_private.aggregator_webhook_events where status in ('PROCESSED', 'IGNORED') and received_at < now() - make_interval(days => d);
  get diagnostics n1 = row_count;
  delete from portfolio_private.aggregator_webhook_rejections where at < now() - make_interval(days => d);
  get diagnostics n2 = row_count;
  return jsonb_build_object('events', n1, 'rejections', n2);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. REFRESH REQUESTS — what EdgeDesk asked the aggregator to fetch, and when
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.portfolio_refresh_requests (
  id                   uuid        primary key default gen_random_uuid(),
  user_id              uuid        not null references auth.users(id) on delete cascade,
  platform_account_id  uuid        not null,
  provider             text        not null,
  requested_by         text        not null,
  status               text        not null default 'REQUESTED',
  requested_at         timestamptz not null default now(),
  responded_at         timestamptz null,
  provider_request_id  text        null,
  provider_response_id text        null,
  provider_code        text        null,
  message              text        null,
  constraint portfolio_refresh_account_fk foreign key (platform_account_id, user_id)
    references public.platform_accounts (id, user_id) on delete cascade,
  constraint portfolio_refresh_by check (requested_by in ('READER', 'SCHEDULER', 'CONNECT', 'OPERATOR')),
  constraint portfolio_refresh_status check (status in ('REQUESTED', 'ACCEPTED', 'SUCCEEDED', 'FAILED', 'REFUSED', 'TIMED_OUT')),
  constraint portfolio_refresh_text check (length(provider) <= 40 and coalesce(length(provider_request_id), 0) <= 120
    and coalesce(length(provider_response_id), 0) <= 120 and coalesce(length(provider_code), 0) <= 40 and coalesce(length(message), 0) <= 300)
);
create index if not exists portfolio_refresh_account on public.portfolio_refresh_requests (platform_account_id, requested_at desc);
create unique index if not exists portfolio_refresh_response_once
  on public.portfolio_refresh_requests (platform_account_id, provider_response_id) where provider_response_id is not null;

-- Ask for a refresh, unless one was asked for this account within
-- p_min_minutes (then null: too soon). A request still open after two hours
-- is closed as TIMED_OUT first.
create or replace function public.portfolio_svc_ag_refresh_begin(p_account uuid, p_requested_by text, p_min_minutes int default 15)
returns uuid language plpgsql set search_path = public, pg_temp as $$
declare a record; rid uuid;
begin
  perform public.portfolio_svc_assert();
  select id, user_id, metadata->>'provider' as provider into a from public.platform_accounts where id = p_account and connection_type = 'AGGREGATOR' for update;
  if not found then raise exception 'portfolio: no such linked account' using errcode = 'P0002'; end if;
  update public.portfolio_refresh_requests set status = 'TIMED_OUT', responded_at = now()
   where platform_account_id = p_account and status in ('REQUESTED', 'ACCEPTED') and requested_at < now() - interval '2 hours';
  if exists (select 1 from public.portfolio_refresh_requests where platform_account_id = p_account and status not in ('FAILED', 'REFUSED')
              and requested_at > now() - make_interval(mins => greatest(1, least(coalesce(p_min_minutes, 15), 10080)))) then
    return null;
  end if;
  insert into public.portfolio_refresh_requests (user_id, platform_account_id, provider, requested_by)
  values (a.user_id, a.id, a.provider, p_requested_by) returning id into rid;
  return rid;
end $$;
