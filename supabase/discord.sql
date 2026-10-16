-- ============================================================================
-- DISCORD POSTS — the send log and the once-per-date claim behind every
-- automated EdgeDesk Discord post (supabase/functions/discord_cron).
--
-- WHAT THIS CREATES.
--   public.discord_posts        one row per post attempt: channel (the NAME of
--                               the webhook secret, never its URL), type,
--                               sent_at, status, error, the Discord message ids
--                               and the payload that was sent. Insert-only, so
--                               a failure cannot be tidied away.
--   public.discord_post_claims  one row per post key (type, channel and date,
--                               e.g. 'slate:DISCORD_WEBHOOK_NFL:2026-10-18').
--                               A post is sent only by the run that CLAIMS its
--                               key, so a cron rerun, a retry or a second tick
--                               never posts the same scorecard or slate twice.
--   discord_claim_post()        claim a key (atomic; see the rules below)
--   discord_finish_post()       record how a claimed send ended
--   discord_release_post()      OPERATOR ONLY: allow a stuck key to be sent again
--
-- THE CLAIM RULES (why a post can never go out twice).
--   * the first claim of a key wins; every later claim is refused
--   * a send Discord REJECTED (an HTTP 4xx answer) is 'failed': it may be
--     claimed again by a rerun, at most p_max_attempts times in all
--   * a send whose outcome is not known (a network error, a timeout, a 5xx
--     after the request left) is 'unknown', and a multi-message post that
--     stopped half way is 'partial'. Neither is ever retried automatically:
--     Discord may have shown it. An operator looks, and if it really did not
--     appear, runs discord_release_post(key, 'why').
--   * dry runs never claim.
--
-- OPERATOR STEPS.
--   1  Run this file in the SQL editor (it is idempotent and additive).
--   2  Run supabase/discord_samples.sql, then supabase/discord_cron.sql.
--
-- Seeing failures:
--   select sent_at, channel, type, status, error from public.discord_posts
--    where status in ('failed', 'partial', 'unknown') order by sent_at desc;
-- ============================================================================

create table if not exists public.discord_posts (
  id                  bigint generated always as identity primary key,
  channel             text not null,
  type                text not null,
  post_key            text,
  post_date           date,
  sent_at             timestamptz not null default now(),
  status              text not null,
  error               text,
  http_status         int,
  attempts            int not null default 0,
  message_ids         text[] not null default '{}',
  discord_channel_id  text,
  thread_id           text,
  payload             jsonb,
  detail              jsonb not null default '{}'::jsonb,
  constraint discord_posts_channel check (channel ~ '^DISCORD_WEBHOOK_[A-Z0-9_]+$'),
  constraint discord_posts_type check (type in ('clv_scorecard', 'slate', 'sample', 'sample_followup', 'adhoc')),
  constraint discord_posts_status check (status in ('sent', 'failed', 'partial', 'unknown', 'dry_run', 'duplicate', 'skipped')),
  -- a webhook URL is a credential: it must never be stored, even by accident
  constraint discord_posts_no_webhook_url check (
    coalesce(error, '') !~* 'discord(app)?\.com/api/(v[0-9]+/)?webhooks/[0-9]+/'
    and coalesce(payload::text, '') !~* 'discord(app)?\.com/api/(v[0-9]+/)?webhooks/[0-9]+/'
    and detail::text !~* 'discord(app)?\.com/api/(v[0-9]+/)?webhooks/[0-9]+/')
);
create index if not exists discord_posts_sent_idx on public.discord_posts (sent_at desc);
create index if not exists discord_posts_problem_idx on public.discord_posts (sent_at desc)
  where status in ('failed', 'partial', 'unknown');
create index if not exists discord_posts_key_idx on public.discord_posts (post_key, sent_at desc);
comment on table public.discord_posts is
  'Every automated Discord post attempt (supabase/functions/discord_cron). channel is the webhook SECRET NAME, never the URL. Insert-only.';

create table if not exists public.discord_post_claims (
  post_key     text primary key,
  channel      text not null,
  type         text not null,
  post_date    date not null,
  state        text not null default 'claimed',
  attempts     int not null default 1,
  message_ids  text[] not null default '{}',
  error        text,
  claimed_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint discord_claims_state check (state in ('claimed', 'sent', 'failed', 'partial', 'unknown')),
  constraint discord_claims_channel check (channel ~ '^DISCORD_WEBHOOK_[A-Z0-9_]+$')
);
comment on table public.discord_post_claims is
  'One row per Discord post key. Only the run that claims a key sends it, so no post goes out twice (supabase/discord.sql header).';

-- ---------------------------------------------------------------------------
-- discord_claim_post: {claimed, state, attempts}. claimed=true means THIS
-- caller owns the send and must finish it with discord_finish_post.
-- ---------------------------------------------------------------------------
create or replace function public.discord_claim_post(
  p_post_key text, p_channel text, p_type text, p_post_date date, p_max_attempts int default 3)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
declare
  v_attempts int;
  v_state text;
begin
  if nullif(p_post_key, '') is null or p_post_date is null then
    raise exception 'discord_claim_post: a post key and a post date are required';
  end if;
  insert into public.discord_post_claims (post_key, channel, type, post_date)
  values (p_post_key, p_channel, p_type, p_post_date)
  on conflict (post_key) do nothing
  returning attempts into v_attempts;
  if found then
    return jsonb_build_object('claimed', true, 'state', 'claimed', 'attempts', v_attempts);
  end if;
  -- only a send Discord REJECTED may be tried again, and only so many times
  update public.discord_post_claims
     set state = 'claimed', attempts = attempts + 1, error = null, claimed_at = now(), updated_at = now()
   where post_key = p_post_key and state = 'failed' and attempts < greatest(coalesce(p_max_attempts, 3), 1)
  returning attempts into v_attempts;
  if found then
    return jsonb_build_object('claimed', true, 'state', 'claimed', 'attempts', v_attempts);
  end if;
  select state, attempts into v_state, v_attempts from public.discord_post_claims where post_key = p_post_key;
  return jsonb_build_object('claimed', false, 'state', v_state, 'attempts', v_attempts);
end $fn$;

create or replace function public.discord_finish_post(
  p_post_key text, p_state text, p_message_ids text[] default '{}', p_error text default null)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
begin
  if p_state is null or p_state not in ('sent', 'failed', 'partial', 'unknown') then
    raise exception 'discord_finish_post: state must be sent, failed, partial or unknown';
  end if;
  update public.discord_post_claims
     set state = p_state, message_ids = coalesce(p_message_ids, '{}'), error = left(p_error, 500), updated_at = now()
   where post_key = p_post_key and state = 'claimed';
  return found;
end $fn$;

-- OPERATOR ONLY (the SQL editor). Makes a 'failed', 'partial', 'unknown' or
-- stuck 'claimed' key sendable again. It cannot touch a 'sent' key: a post
-- that went out is never re-sent.
create or replace function public.discord_release_post(p_post_key text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
declare
  v_state text;
begin
  if nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception 'discord_release_post: say why (p_note), e.g. ''checked the channel: it never appeared''';
  end if;
  update public.discord_post_claims
     set state = 'failed', attempts = 0, updated_at = now(),
         error = left(coalesce(error || ' | ', '') || 'released ' || now()::text || ': ' || p_note, 500)
   where post_key = p_post_key and state <> 'sent'
  returning state into v_state;
  if not found then
    select state into v_state from public.discord_post_claims where post_key = p_post_key;
    return jsonb_build_object('released', false, 'state', v_state);
  end if;
  return jsonb_build_object('released', true, 'state', v_state);
end $fn$;

-- ---------------------------------------------------------------------------
-- ACCESS. Nothing here is for readers. The function writes with the service
-- role: the log is insert-only for it, the claims change only through the
-- claim functions, and the release is not callable by any API role at all.
-- ---------------------------------------------------------------------------
alter table public.discord_posts enable row level security;
alter table public.discord_post_claims enable row level security;
revoke all on public.discord_posts, public.discord_post_claims from public, anon, authenticated;
revoke all on function public.discord_claim_post(text, text, text, date, int) from public, anon, authenticated;
revoke all on function public.discord_finish_post(text, text, text[], text) from public, anon, authenticated;
revoke all on function public.discord_release_post(text, text) from public, anon, authenticated;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on public.discord_posts, public.discord_post_claims from service_role';
    execute 'grant select, insert on public.discord_posts to service_role';
    execute 'grant select on public.discord_post_claims to service_role';
    execute 'grant execute on function public.discord_claim_post(text, text, text, date, int) to service_role';
    execute 'grant execute on function public.discord_finish_post(text, text, text[], text) to service_role';
    execute 'revoke all on function public.discord_release_post(text, text) from service_role';
  end if;
end $g$;

notify pgrst, 'reload schema';

-- THE REPORT. Every row should say ok.
with checks as (
  select 1 as n, 'discord_posts and discord_post_claims exist with RLS on' as check_name,
         (select count(*) from pg_class where oid in ('public.discord_posts'::regclass, 'public.discord_post_claims'::regclass)
            and relrowsecurity)::int as got, 2 as want
  union all select 2, 'no reader role can read or write either table',
         (case when not has_table_privilege('anon', 'public.discord_posts', 'select')
                and not has_table_privilege('authenticated', 'public.discord_posts', 'insert')
                and not has_table_privilege('anon', 'public.discord_post_claims', 'select')
                and not has_table_privilege('authenticated', 'public.discord_post_claims', 'update')
               then 1 else 0 end), 1
  union all select 3, 'the log is insert-only for the service role (no update, no delete)',
         (case when not exists (select 1 from pg_roles where rolname = 'service_role') then 1
               when has_table_privilege('service_role', 'public.discord_posts', 'insert')
                and not has_table_privilege('service_role', 'public.discord_posts', 'update')
                and not has_table_privilege('service_role', 'public.discord_posts', 'delete')
                and not has_table_privilege('service_role', 'public.discord_post_claims', 'update')
               then 1 else 0 end), 1
  union all select 4, 'claim / finish are callable by the service role only; release by no API role',
         (case when not has_function_privilege('anon', 'public.discord_claim_post(text, text, text, date, int)', 'execute')
                and not has_function_privilege('authenticated', 'public.discord_finish_post(text, text, text[], text)', 'execute')
                and not has_function_privilege('anon', 'public.discord_release_post(text, text)', 'execute')
                and (not exists (select 1 from pg_roles where rolname = 'service_role')
                     or (has_function_privilege('service_role', 'public.discord_claim_post(text, text, text, date, int)', 'execute')
                         and not has_function_privilege('service_role', 'public.discord_release_post(text, text)', 'execute')))
               then 1 else 0 end), 1
  union all select 5, 'a webhook URL cannot be written into the log',
         (select count(*) from pg_constraint where conname = 'discord_posts_no_webhook_url')::int, 1
)
select n, check_name, got, want, case when got = want then 'ok' else 'CHECK THIS' end as status
from checks order by 1;
