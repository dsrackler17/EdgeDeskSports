-- ============================================================================
-- DISCORD FREE RESEARCH SAMPLES — the ledger that makes the public sample
-- record impossible to cherry-pick (supabase/functions/discord_cron, action
-- 'samples').
--
-- WHAT THIS CREATES.
--   discord_sample_sightings   the first time EdgeDesk saw a CFB / NFL game
--                              classified INVESTIGATE or MONITOR, with the
--                              consensus line at that moment. first_seen_at is
--                              the DATABASE clock, never a value the function
--                              sends, so a detection cannot be backdated.
--                              Append-only.
--   discord_sample_selections  one row per sport and slate date: every
--                              candidate, its order keys, whether it was
--                              eligible and why not, and which games were
--                              chosen and why. Written once, before any game on
--                              the slate is played. Append-only.
--   discord_samples            one row per chosen game. Everything decided at
--                              selection (game, rank, classification, the
--                              detection time and line, the side the module
--                              flagged, the scheduled post time) is frozen; the
--                              outcome columns (posted, missed, closing line,
--                              CLV, follow-up) are each written once, and the
--                              status only moves forward:
--                                scheduled -> posted -> followed_up
--                                scheduled -> missed
--                              No row is ever deleted, so a sample that went
--                              badly stays in the record exactly like one that
--                              went well.
--   discord_record_selection() writes a selection and its samples in one
--                              transaction. The detection time and line come
--                              from the sightings table, not from the caller.
--
-- OPERATOR STEPS. Run supabase/discord.sql first, then this file, then
-- supabase/discord_cron.sql. Idempotent and additive.
-- ============================================================================

do $$
begin
  if to_regclass('public.discord_posts') is null then
    raise exception 'Apply supabase/discord.sql first: the samples post through its log and claims.';
  end if;
end $$;

create table if not exists public.discord_sample_sightings (
  sport           text not null,
  game_id         text not null,
  classification  text not null,
  first_seen_at   timestamptz not null default now(),
  kickoff_at      timestamptz,
  home            text,
  away            text,
  side            text,
  line_home       numeric(6,2),
  line_total      numeric(6,2),
  line_as_of      timestamptz,
  line_source     text,
  signal          jsonb not null default '{}'::jsonb,
  primary key (sport, game_id, classification),
  constraint discord_sightings_sport check (sport in ('cfb', 'nfl')),
  constraint discord_sightings_class check (classification in ('INVESTIGATE', 'MONITOR')),
  constraint discord_sightings_side check (side is null or side in ('home', 'away'))
);

create table if not exists public.discord_sample_selections (
  sport            text not null,
  slate_date       date not null,
  selected_at      timestamptz not null default now(),
  rule_version     text not null,
  delay_hours      numeric not null,
  buffer_minutes   int not null,
  candidates       jsonb not null default '[]'::jsonb,
  chosen           jsonb not null default '[]'::jsonb,
  note             text,
  primary key (sport, slate_date),
  constraint discord_selections_sport check (sport in ('cfb', 'nfl'))
);

create table if not exists public.discord_samples (
  id                   bigint generated always as identity primary key,
  sport                text not null,
  slate_date           date not null,
  game_id              text not null,
  rank                 int not null,
  classification       text not null,
  reason               text not null,
  home                 text,
  away                 text,
  kickoff_at           timestamptz not null,
  detected_at          timestamptz not null,
  line_at_detection    numeric(6,2),
  total_at_detection   numeric(6,2),
  side                 text,
  line_source          text,
  signal               jsonb not null default '{}'::jsonb,
  channel              text not null,
  scheduled_post_at    timestamptz not null,
  status               text not null default 'scheduled',
  posted_at            timestamptz,
  line_at_post         numeric(6,2),
  total_at_post        numeric(6,2),
  line_as_of_post      timestamptz,
  message_id           text,
  discord_channel_id   text,
  thread_id            text,
  miss_reason          text,
  close_line           numeric(6,2),
  close_source         text,
  close_quality        text,
  close_observed_at    timestamptz,
  clv_at_detection     numeric(6,2),
  clv_at_post          numeric(6,2),
  followup_at          timestamptz,
  followup_message_id  text,
  followup_note        text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint discord_samples_one_per_game unique (sport, slate_date, game_id),
  constraint discord_samples_selection foreign key (sport, slate_date)
    references public.discord_sample_selections (sport, slate_date),
  constraint discord_samples_class check (classification in ('INVESTIGATE', 'MONITOR')),
  constraint discord_samples_side check (side is null or side in ('home', 'away')),
  constraint discord_samples_channel check (channel in ('DISCORD_WEBHOOK_CFB', 'DISCORD_WEBHOOK_NFL')),
  constraint discord_samples_status check (status in ('scheduled', 'posted', 'missed', 'followed_up')),
  constraint discord_samples_posted check (status not in ('posted', 'followed_up') or (posted_at is not null and message_id is not null)),
  constraint discord_samples_missed check (status <> 'missed' or miss_reason is not null),
  constraint discord_samples_followed check (status <> 'followed_up' or followup_at is not null),
  constraint discord_samples_post_window check (posted_at is null or posted_at <= kickoff_at - interval '60 minutes')
);
create index if not exists discord_samples_due_idx on public.discord_samples (status, scheduled_post_at);
create index if not exists discord_samples_date_idx on public.discord_samples (slate_date);

-- ---------------------------------------------------------------------------
-- THE GUARDS.
-- ---------------------------------------------------------------------------
create or replace function public.discord_append_only()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $fn$
begin
  if tg_op = 'INSERT' then
    -- the database's clock is the record, not the caller's
    if tg_table_name = 'discord_sample_sightings' then new.first_seen_at := now(); end if;
    if tg_table_name = 'discord_sample_selections' then new.selected_at := now(); end if;
    return new;
  end if;
  raise exception '%: append-only — % is not allowed', tg_table_name, lower(tg_op);
end $fn$;

drop trigger if exists discord_sightings_append_only on public.discord_sample_sightings;
create trigger discord_sightings_append_only before insert or update or delete on public.discord_sample_sightings
  for each row execute function public.discord_append_only();
drop trigger if exists discord_selections_append_only on public.discord_sample_selections;
create trigger discord_selections_append_only before insert or update or delete on public.discord_sample_selections
  for each row execute function public.discord_append_only();

create or replace function public.discord_samples_guard()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $fn$
declare
  v_once text[] := array['posted_at', 'line_at_post', 'total_at_post', 'line_as_of_post', 'message_id',
    'discord_channel_id', 'thread_id', 'miss_reason', 'close_line', 'close_source', 'close_quality',
    'close_observed_at', 'clv_at_detection', 'clv_at_post', 'followup_at', 'followup_message_id', 'followup_note'];
  v_mutable text[] := v_once || array['status', 'updated_at'];
  o jsonb;
  n jsonb;
  c text;
begin
  if tg_op = 'DELETE' then
    raise exception 'discord_samples: a sample is never deleted (the public record keeps every one)';
  end if;
  if tg_op = 'INSERT' then
    new.status := 'scheduled';
    new.created_at := now();
    new.updated_at := now();
    if num_nonnulls(new.posted_at, new.message_id, new.miss_reason, new.close_line, new.clv_at_post, new.followup_at) > 0 then
      raise exception 'discord_samples: a new sample starts scheduled, with no outcome';
    end if;
    return new;
  end if;
  o := to_jsonb(old);
  n := to_jsonb(new);
  if (o - v_mutable) is distinct from (n - v_mutable) then
    raise exception 'discord_samples: what was decided at selection is frozen';
  end if;
  foreach c in array v_once loop
    if (o -> c) <> 'null'::jsonb and (o -> c) is distinct from (n -> c) then
      raise exception 'discord_samples: % is written once', c;
    end if;
  end loop;
  if new.status is distinct from old.status and not (
       (old.status = 'scheduled' and new.status in ('posted', 'missed'))
    or (old.status = 'posted' and new.status = 'followed_up')) then
    raise exception 'discord_samples: status cannot move from % to %', old.status, new.status;
  end if;
  new.updated_at := now();
  return new;
end $fn$;

drop trigger if exists discord_samples_guard on public.discord_samples;
create trigger discord_samples_guard before insert or update or delete on public.discord_samples
  for each row execute function public.discord_samples_guard();

-- ---------------------------------------------------------------------------
-- discord_record_selection: the selection and its samples, in one transaction.
-- A second call for the same sport and date changes nothing (created=false).
-- Every chosen game must already have a sighting for its classification; its
-- detection time and line are copied from there. The scheduled post time is
-- the earlier of detection + delay and kickoff - (60 + buffer) minutes.
-- ---------------------------------------------------------------------------
create or replace function public.discord_record_selection(
  p_sport text, p_slate_date date, p_rule_version text, p_delay_hours numeric, p_buffer_minutes int,
  p_channel text, p_candidates jsonb, p_chosen jsonb, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
declare
  v_want int := jsonb_array_length(coalesce(p_chosen, '[]'::jsonb));
  v_got int;
begin
  if p_delay_hours is null or p_delay_hours < 0 or p_buffer_minutes is null or p_buffer_minutes < 0 then
    raise exception 'discord_record_selection: delay and buffer must be non-negative';
  end if;
  if v_want > 2 then
    raise exception 'discord_record_selection: at most 2 samples per slate';
  end if;
  insert into public.discord_sample_selections (sport, slate_date, rule_version, delay_hours, buffer_minutes, candidates, chosen, note)
  values (p_sport, p_slate_date, p_rule_version, p_delay_hours, p_buffer_minutes,
          coalesce(p_candidates, '[]'::jsonb), coalesce(p_chosen, '[]'::jsonb), p_note)
  on conflict (sport, slate_date) do nothing;
  if not found then
    return jsonb_build_object('created', false,
      'samples', (select count(*) from public.discord_samples where sport = p_sport and slate_date = p_slate_date));
  end if;
  insert into public.discord_samples (sport, slate_date, game_id, rank, classification, reason, home, away,
    kickoff_at, detected_at, line_at_detection, total_at_detection, side, line_source, signal, channel, scheduled_post_at)
  select p_sport, p_slate_date, c.game_id, c.rank, c.classification, c.reason, c.home, c.away,
         c.kickoff_at, s.first_seen_at, s.line_home, s.line_total, c.side, s.line_source, coalesce(c.signal, '{}'::jsonb), p_channel,
         least(s.first_seen_at + make_interval(secs => p_delay_hours * 3600),
               c.kickoff_at - make_interval(mins => 60 + p_buffer_minutes))
    from jsonb_to_recordset(coalesce(p_chosen, '[]'::jsonb))
         as c(game_id text, rank int, classification text, reason text, home text, away text,
              kickoff_at timestamptz, side text, signal jsonb)
    join public.discord_sample_sightings s
      on s.sport = p_sport and s.game_id = c.game_id and s.classification = c.classification;
  get diagnostics v_got = row_count;
  if v_got <> v_want then
    raise exception 'discord_record_selection: % of % chosen games have no sighting for their classification — nothing recorded', v_want - v_got, v_want;
  end if;
  return jsonb_build_object('created', true, 'samples', v_got);
end $fn$;

-- ---------------------------------------------------------------------------
-- ACCESS. Service role only. Sightings: insert (ignore-duplicates upsert) and
-- read. Selections: read; written only through discord_record_selection.
-- Samples: read and update (the guard decides which updates are legal).
-- ---------------------------------------------------------------------------
alter table public.discord_sample_sightings enable row level security;
alter table public.discord_sample_selections enable row level security;
alter table public.discord_samples enable row level security;
revoke all on public.discord_sample_sightings, public.discord_sample_selections, public.discord_samples
  from public, anon, authenticated;
revoke all on function public.discord_record_selection(text, date, text, numeric, int, text, jsonb, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.discord_append_only() from public, anon, authenticated;
revoke all on function public.discord_samples_guard() from public, anon, authenticated;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on public.discord_sample_sightings, public.discord_sample_selections, public.discord_samples from service_role';
    execute 'grant select, insert on public.discord_sample_sightings to service_role';
    execute 'grant select on public.discord_sample_selections to service_role';
    execute 'grant select, update on public.discord_samples to service_role';
    execute 'grant execute on function public.discord_record_selection(text, date, text, numeric, int, text, jsonb, jsonb, text) to service_role';
  end if;
end $g$;

notify pgrst, 'reload schema';

-- THE REPORT. Every row should say ok.
with checks as (
  select 1 as n, 'the three sample tables exist with RLS on' as check_name,
         (select count(*) from pg_class where oid in ('public.discord_sample_sightings'::regclass,
            'public.discord_sample_selections'::regclass, 'public.discord_samples'::regclass) and relrowsecurity)::int as got, 3 as want
  union all select 2, 'sightings and selections are append-only; samples are guarded',
         (select count(*) from pg_trigger where not tgisinternal and tgname in
            ('discord_sightings_append_only', 'discord_selections_append_only', 'discord_samples_guard'))::int, 3
  union all select 3, 'no reader role can read the ledger',
         (case when not has_table_privilege('anon', 'public.discord_samples', 'select')
                and not has_table_privilege('authenticated', 'public.discord_sample_selections', 'select')
                and not has_table_privilege('authenticated', 'public.discord_sample_sightings', 'insert')
               then 1 else 0 end), 1
  union all select 4, 'the service role cannot delete, nor write a selection or sample directly',
         (case when not exists (select 1 from pg_roles where rolname = 'service_role') then 1
               when not has_table_privilege('service_role', 'public.discord_samples', 'delete')
                and not has_table_privilege('service_role', 'public.discord_samples', 'insert')
                and not has_table_privilege('service_role', 'public.discord_sample_selections', 'insert')
                and not has_table_privilege('service_role', 'public.discord_sample_sightings', 'update')
               then 1 else 0 end), 1
  union all select 5, 'discord_record_selection is callable by the service role only',
         (case when not has_function_privilege('anon', 'public.discord_record_selection(text, date, text, numeric, int, text, jsonb, jsonb, text)', 'execute')
                and not has_function_privilege('authenticated', 'public.discord_record_selection(text, date, text, numeric, int, text, jsonb, jsonb, text)', 'execute')
               then 1 else 0 end), 1
)
select n, check_name, got, want, case when got = want then 'ok' else 'CHECK THIS' end as status
from checks order by 1;
