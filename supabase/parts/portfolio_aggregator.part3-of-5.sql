-- portfolio_aggregator -- part 3 of 5.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- The aggregator's answer to the request itself (accepted, refused, failed).
create or replace function public.portfolio_svc_ag_refresh_update(p_refresh uuid, p_status text, p_provider_request_id text default null,
    p_code text default null, p_message text default null)
returns void language plpgsql set search_path = public, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  update public.portfolio_refresh_requests set status = p_status, provider_request_id = coalesce(left(p_provider_request_id, 120), provider_request_id),
         provider_code = left(p_code, 40), message = left(p_message, 300),
         responded_at = case when p_status in ('SUCCEEDED', 'FAILED', 'REFUSED', 'TIMED_OUT') then now() else responded_at end
   where id = p_refresh;
end $$;

-- The outcome of the latest refresh, as the aggregator's API reports it on
-- the linked account (read by the sync, never taken from a webhook). It
-- closes the newest open request made before it; seen twice, it changes nothing.
create or replace function public.portfolio_svc_ag_refresh_seen(p_account uuid, p_provider_response_id text, p_ok boolean,
    p_code text default null, p_message text default null, p_at timestamptz default null)
returns boolean language plpgsql set search_path = public, pg_temp as $$
declare rid uuid;
begin
  perform public.portfolio_svc_assert();
  if nullif(btrim(p_provider_response_id), '') is null then return false; end if;
  if exists (select 1 from public.portfolio_refresh_requests where platform_account_id = p_account and provider_response_id = p_provider_response_id) then
    return false;
  end if;
  select id into rid from public.portfolio_refresh_requests
   where platform_account_id = p_account and status in ('REQUESTED', 'ACCEPTED') and requested_at <= coalesce(p_at, now()) + interval '1 minute'
   order by requested_at desc limit 1;
  if rid is null then return false; end if;
  update public.portfolio_refresh_requests set status = case when p_ok then 'SUCCEEDED' else 'FAILED' end, provider_response_id = left(p_provider_response_id, 120),
         provider_code = left(p_code, 40), message = left(p_message, 300), responded_at = coalesce(p_at, now())
   where id = rid;
  return true;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. SETTLEMENT HISTORY — append-only, the reader's own
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.portfolio_position_settlements (
  id                   bigserial   primary key,
  user_id              uuid        not null references auth.users(id) on delete cascade,
  position_id          uuid        not null,
  platform             text        not null,
  external_position_id text        null,
  previous_status      text        null,
  status               text        not null,
  previous_payout      numeric     null,
  reported_payout      numeric     null,
  settled_at           timestamptz null,
  run_id               uuid        null,
  recorded_at          timestamptz not null default now(),
  constraint portfolio_settlements_position_fk foreign key (position_id, user_id)
    references public.portfolio_positions (id, user_id) on delete cascade,
  constraint portfolio_settlements_status check (status in ('OPEN', 'WON', 'LOST', 'PUSH', 'VOID', 'CASHED_OUT', 'SETTLED')
    and (previous_status is null or previous_status in ('OPEN', 'WON', 'LOST', 'PUSH', 'VOID', 'CASHED_OUT', 'SETTLED'))),
  constraint portfolio_settlements_text check (length(platform) <= 48 and coalesce(length(external_position_id), 0) <= 200)
);
create index if not exists portfolio_settlements_position on public.portfolio_position_settlements (position_id, recorded_at);
create index if not exists portfolio_settlements_user on public.portfolio_position_settlements (user_id, recorded_at desc);
create or replace function public.portfolio_position_settlements_frozen() returns trigger
language plpgsql as $$
begin
  raise exception 'portfolio: the settlement history is append-only' using errcode = '42501';
end $$;
drop trigger if exists portfolio_position_settlements_frozen_trg on public.portfolio_position_settlements;
create trigger portfolio_position_settlements_frozen_trg before update on public.portfolio_position_settlements
  for each row execute function public.portfolio_position_settlements_frozen();
