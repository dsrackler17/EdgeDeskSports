-- =============================================================================
-- fairline_tape.sql — The Tape: every Monday morning (America/Chicago), one
-- snapshot of last week per Fairline reader, kept for good, shown on the
-- Fairline page and sent by email through the existing email pipeline.
-- docs/fairline.md
--
-- NO PICKS. The Tape is the reader's own week, measured: the record and P/L,
-- the closing-line value, the prices they got against EdgeDesk's fair, what
-- changed in their leaks, and the best number they got. It never says what
-- to bet next. Where the pipeline does not own a number it is not shown.
--
-- THE WEEK is Monday 00:00 to Monday 00:00 in America/Chicago (a DST week is
-- 167 or 169 hours long, and is still one week). A bet belongs to the week
-- its game started in; a bet with no known start, to the week it was placed
-- (fairline_slices_at(), the same rule and the same arithmetic as The Leaks).
--
-- WHAT IS IN A TAPE (fairline_tape_compute()):
--   week_stats   the week's bets: settled, open, the record, dollars and units
--                P/L, the return in the slice's own measure, average CLV and
--                the beat-close rate (The Leaks' "all" slice over the week).
--   price        the bets checked against EdgeDesk's fair when they were
--                placed (Bet Checker's frozen entry_edge_pct): how many, the
--                average points better or worse than fair, how many beat it.
--                A bet that was never checked is counted, never guessed.
--   best         the best number of the week: the largest entry edge over
--                fair; with none, the best captured close; with neither, none.
--   changes      every slice whose label changed this week, or that crossed
--                the minimum sample: the slices over the bets before the week
--                against the slices over the bets through it.
--   quiet        no bet in the week and nothing changed. A quiet Tape is kept
--                and shown, and not emailed.
--
-- WHAT IT IS
--   fairline_tapes            APPEND-ONLY. One row per reader per week: never
--                             updated, never deleted while its reader exists
--                             (an account deletion still removes its Tapes).
--   fairline_tape_deliveries  one email per Tape, its status: pending,
--                             sending, sent, skipped (with the reason), failed.
--   fairline_tape_settings    ONE row. email_enabled defaults to FALSE: no
--                             Tape is emailed until an operator switches it
--                             on, AND lifecycle_settings.sending_enabled (the
--                             email pipeline's own switch) is on.
--   user_preferences.fairline_tape_emails  the reader's own opt-out (default
--                             on), from the page or the email's link.
--   fairline_tape_build()     service role / pg_cron: builds last week's Tape
--                             for every Fairline reader, once
--                             (fairline_tape_cron.sql schedules it).
--   fairline_tape_due(n) / fairline_tape_mark()  the sender's (service role):
--                             claim, re-check NOW, mark. A Tape not emailed
--                             within tape.email_within_hours of its week's end
--                             is not emailed at all (it stays in the app). tools/fairline/
--                             tape_send.js, run by the trial emails' hourly job
--                             (.github/workflows/lifecycle-email.yml).
--   fairline_tape_unsubscribe(token)  anon: the link in every Tape email,
--                             the reader's lifecycle_tokens token; only turns
--                             The Tape emails OFF.
--   fairline_tapes()          the page: the caller's Tapes. Paid only.
--   fairline_tape_email(on)   the page: the caller's own opt-in / opt-out.
--
-- THE EXISTING EMAIL PIPELINE (lifecycle_email.sql): the same provider and
-- sender (tools/lifecycle/send.js), the same from / reply-to / site / postal
-- address (lifecycle_settings), the same per-reader unsubscribe token
-- (lifecycle_tokens), the same bounce and complaint list
-- (newsletter_suppressions, when present), the same copy rule.
--
-- REQUIRES fairline.sql (fairline_slices_at, fairline_bets_for,
-- fairline_paid, fairline_rules), lifecycle_email.sql (lifecycle_settings,
-- lifecycle_tokens) and personal_research.sql (user_preferences).
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- Mirrored byte for byte in migrations/20261029120000_fairline_tape.sql.
-- =============================================================================

do $req$
begin
  if to_regprocedure('public.fairline_slices_at(uuid,timestamptz,timestamptz)') is null
     or to_regprocedure('public.fairline_paid(uuid,timestamptz)') is null
     or to_regprocedure('public.fairline_rules()') is null then
    raise exception 'fairline_tape.sql builds on The Leaks: apply supabase/fairline.sql (with fairline_slices_at and the tape rules) first';
  end if;
  if (public.fairline_rules() -> 'tape') is null then
    raise exception 'fairline_tape.sql reads the tape rules: apply the current supabase/fairline.sql first';
  end if;
  if to_regclass('public.lifecycle_settings') is null or to_regclass('public.lifecycle_tokens') is null then
    raise exception 'fairline_tape.sql sends through the existing email pipeline: apply supabase/lifecycle_email.sql first';
  end if;
  if to_regclass('public.user_preferences') is null then
    raise exception 'fairline_tape.sql keeps the reader''s opt-out in public.user_preferences: apply supabase/personal_research.sql first';
  end if;
end
$req$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. THE TABLES
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.user_preferences add column if not exists fairline_tape_emails boolean not null default true;

create table if not exists public.fairline_tape_settings (
  id             int primary key default 1 check (id = 1),
  email_enabled  boolean not null default false,
  updated_at     timestamptz not null default now()
);
insert into public.fairline_tape_settings (id) values (1) on conflict (id) do nothing;
alter table public.fairline_tape_settings enable row level security;
revoke all on public.fairline_tape_settings from anon, authenticated;

create table if not exists public.fairline_tapes (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references auth.users(id) on delete cascade,
  week_start     date not null,
  starts_at      timestamptz not null,
  ends_at        timestamptz not null,
  built_at       timestamptz not null default now(),
  rules_version  text not null,
  tape           jsonb not null,
  constraint fairline_tapes_once unique (user_id, week_start),
  constraint fairline_tapes_week check (ends_at > starts_at and extract(isodow from week_start) = 1),
  constraint fairline_tapes_shape check (jsonb_typeof(tape) = 'object')
);
comment on table public.fairline_tapes is
  'APPEND-ONLY. One Tape per Fairline reader per week (Monday to Monday, America/Chicago): last week''s record, P/L, CLV, prices against EdgeDesk''s fair, the leaks that changed, the best number. Never updated; never deleted while its reader exists.';
create index if not exists fairline_tapes_user on public.fairline_tapes (user_id, week_start desc);
alter table public.fairline_tapes enable row level security;
revoke all on public.fairline_tapes from anon, authenticated;

-- 2. APPEND-ONLY: no UPDATE, no TRUNCATE, and no DELETE while the reader
-- exists. Deleting the account (auth.users) still removes its Tapes: by the
-- time the cascade reaches this table the reader's row is gone.
create or replace function public.fairline_tapes_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'fairline_tapes is append-only: Tape % is never rewritten', old.id using errcode = 'restrict_violation';
  end if;
  if tg_op = 'TRUNCATE' then
    raise exception 'fairline_tapes is append-only: it is never truncated' using errcode = 'restrict_violation';
  end if;
  if exists (select 1 from auth.users u where u.id = old.user_id) then
    raise exception 'fairline_tapes is append-only: Tape % is deleted only with its reader''s account', old.id using errcode = 'restrict_violation';
  end if;
  return old;
end;
$$;
drop trigger if exists fairline_tapes_no_update on public.fairline_tapes;
create trigger fairline_tapes_no_update before update or delete on public.fairline_tapes
  for each row execute function public.fairline_tapes_guard();
drop trigger if exists fairline_tapes_no_truncate on public.fairline_tapes;
create trigger fairline_tapes_no_truncate before truncate on public.fairline_tapes
  for each statement execute function public.fairline_tapes_guard();

create table if not exists public.fairline_tape_deliveries (
  id           bigint generated always as identity primary key,
  tape_id      bigint not null unique references public.fairline_tapes(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'skipped', 'failed')),
  attempts     int not null default 0,
  skip_reason  text,
  last_error   text,
  provider_id  text,
  claimed_at   timestamptz,
  sent_at      timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists fairline_tape_deliveries_due on public.fairline_tape_deliveries (status, created_at);
alter table public.fairline_tape_deliveries enable row level security;
revoke all on public.fairline_tape_deliveries from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. THE WEEK
-- ─────────────────────────────────────────────────────────────────────────────
-- The last complete week before p_at: [Monday 00:00, next Monday 00:00) local.
create or replace function public.fairline_tape_week(p_at timestamptz)
returns table (week_start date, starts_at timestamptz, ends_at timestamptz)
language sql
stable
set search_path = public, pg_temp
as $$
  with z as (select public.fairline_rules() #>> '{tape,time_zone}' as tz),
       m as (select date_trunc('week', p_at at time zone z.tz) as monday, z.tz from z)
  select (m.monday - interval '7 days')::date,
         (m.monday - interval '7 days') at time zone m.tz,
         m.monday at time zone m.tz
    from m;
$$;

-- When the next Tape is built: the coming Monday at build_hour, local.
create or replace function public.fairline_tape_next(p_at timestamptz)
returns timestamptz
language sql
stable
set search_path = public, pg_temp
as $$
  with z as (select public.fairline_rules() #>> '{tape,time_zone}' as tz,
                    (public.fairline_rules() #>> '{tape,build_hour}')::int as h),
       c as (select date_trunc('week', p_at at time zone z.tz) + make_interval(hours => z.h) as at_local, z.tz,
                    p_at at time zone z.tz as now_local from z)
  select case when c.now_local < c.at_local then c.at_local else c.at_local + interval '7 days' end at time zone c.tz from c;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. ONE TAPE
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.fairline_tape_compute(p_user uuid, p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  r jsonb := public.fairline_rules();
  v_week jsonb;
  v_stats jsonb;
  v_price jsonb;
  v_best jsonb;
  v_changes jsonb;
  v_bets int;
  v_tz text := public.fairline_rules() #>> '{tape,time_zone}';
begin
  if p_user is null or p_from is null or p_to is null or p_to <= p_from then
    raise exception 'fairline_tape_compute: a reader and a week' using errcode = '22023';
  end if;
  if auth.uid() is distinct from p_user and not public.bet_checker_trusted() then
    raise exception 'fairline: a reader may only read their own Tape' using errcode = '42501';
  end if;

  -- the week's bets, through The Leaks' own arithmetic
  select s - 'set_hash' - 'dim' - 'val' - 'ord' - 'label' - 'label_basis' - 'small_sample' into v_stats
    from jsonb_array_elements(public.fairline_slices_at(p_user, p_from, p_to)) s
   where s ->> 'dim' = 'all';

  -- prices against EdgeDesk's fair when placed (Bet Checker's frozen entry
  -- edge), and the best number of the week
  with b as (
    select f.*, u.entry_edge_pct, u.entry_grade
      from public.fairline_bets_for(p_user) f
      left join public.user_bets u on u.id = f.bet_id
     where coalesce(f.starts_at, f.placed_at) >= p_from and coalesce(f.starts_at, f.placed_at) < p_to
  ), priced as (
    select * from b where b.entry_grade in ('green', 'yellow', 'red') and b.entry_edge_pct is not null
  )
  select (select count(*)::int from b),
         jsonb_build_object('bets', (select count(*) from b), 'priced', (select count(*) from priced),
                            'avg_edge_pts', (select round(avg(p.entry_edge_pct), 2) from priced p),
                            'better_than_fair', (select count(*) from priced p where p.entry_edge_pct > 0),
                            'worse_than_fair', (select count(*) from priced p where p.entry_edge_pct < 0)),
         coalesce(
           (select jsonb_build_object('measure', 'fair', 'edge_pts', round(p.entry_edge_pct, 2), 'clv_pct', round(p.clv_pct, 2),
                     'sport', p.sport, 'market', p.market, 'event', p.event, 'selection', p.selection, 'line', p.line,
                     'odds_american', p.odds_american, 'platform', p.platform, 'starts_at', p.starts_at, 'result', p.result)
              from priced p order by p.entry_edge_pct desc, p.placed_at, p.bet_ref limit 1),
           (select jsonb_build_object('measure', 'close', 'clv_pct', round(c.clv_pct, 2),
                     'sport', c.sport, 'market', c.market, 'event', c.event, 'selection', c.selection, 'line', c.line,
                     'odds_american', c.odds_american, 'platform', c.platform, 'starts_at', c.starts_at, 'result', c.result)
              from b c where c.clv_status = 'captured' and c.clv_pct is not null
             order by c.clv_pct desc, c.placed_at, c.bet_ref limit 1))
    into v_bets, v_price, v_best;

  -- what changed: the slices before the week against the slices through it
  with bef as (
    select s from jsonb_array_elements(public.fairline_slices_at(p_user, null, p_from)) s where s ->> 'dim' <> 'all'
  ), aft as (
    select s from jsonb_array_elements(public.fairline_slices_at(p_user, null, p_to)) s where s ->> 'dim' <> 'all'
  ), ch as (
    select a.s ->> 'dim' as dim, a.s ->> 'val' as val, (a.s ->> 'ord')::int as ord,
           b.s ->> 'label' as was, a.s ->> 'label' as now_label,
           case when b.s is null or b.s ->> 'label' is null then 'crossed' else 'changed' end as kind,
           (a.s ->> 'bets')::int as bets, coalesce((b.s ->> 'bets')::int, 0) as bets_before,
           a.s -> 'pl_basis_value' as pl_basis_value, (a.s ->> 'pl_basis_value')::numeric as pl_n,
           a.s ->> 'roi_basis' as roi_basis, a.s -> 'roi_pct' as roi_pct,
           a.s -> 'avg_clv_pct' as avg_clv_pct, (a.s ->> 'clv_bets')::int as clv_bets, a.s ->> 'label_basis' as label_basis
      from aft a
      left join bef b on b.s ->> 'dim' = a.s ->> 'dim' and b.s ->> 'val' = a.s ->> 'val'
     where a.s ->> 'label' is not null and (b.s is null or b.s ->> 'label' is distinct from a.s ->> 'label')
  )
  select coalesce(jsonb_agg(jsonb_build_object('dim', ch.dim, 'val', ch.val, 'kind', ch.kind, 'from', ch.was, 'to', ch.now_label,
                    'bets', ch.bets, 'bets_before', ch.bets_before, 'pl_basis_value', ch.pl_basis_value, 'roi_basis', ch.roi_basis,
                    'roi_pct', ch.roi_pct, 'avg_clv_pct', ch.avg_clv_pct, 'clv_bets', ch.clv_bets, 'label_basis', ch.label_basis)
           order by (ch.now_label = 'real_leak') desc, ch.pl_n nulls last, ch.dim, ch.ord, ch.val), '[]'::jsonb)
    into v_changes from ch;

  v_week := jsonb_build_object('start', to_char(p_from at time zone v_tz, 'YYYY-MM-DD'),
                               'end', to_char((p_to at time zone v_tz) - interval '1 day', 'YYYY-MM-DD'),
                               'starts_at', p_from, 'ends_at', p_to, 'time_zone', v_tz);
  return jsonb_build_object(
    'version', 'fairline-tape-v1', 'rules_version', r ->> 'version', 'week', v_week,
    -- the rules it was read by, so a stored Tape still says what it meant
    -- after the rules move on
    'rules', jsonb_build_object('version', r -> 'version', 'min_sample_bets', r -> 'min_sample_bets', 'min_clv_bets', r -> 'min_clv_bets',
                                'odds_buckets', r -> 'odds_buckets', 'lead_buckets', r -> 'lead_buckets', 'stake_buckets', r -> 'stake_buckets'),
    'week_stats', coalesce(v_stats, jsonb_build_object('bets', 0, 'pending', 0, 'wins', 0, 'losses', 0, 'pushes', 0, 'cashouts', 0,
                                                       'clv_bets', 0, 'beat_close', 0, 'dollars_bets', 0, 'units_bets', 0)),
    'price', v_price, 'best', v_best, 'changes', v_changes,
    'quiet', v_bets = 0 and jsonb_array_length(v_changes) = 0);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. THE MONDAY BUILD (pg_cron, fairline_tape_cron.sql)
-- ─────────────────────────────────────────────────────────────────────────────
-- Due on Monday from build_hour local; outside that it builds nothing and
-- says so (the cron job fires in both UTC hours that can be 06:00 in
-- Chicago). One Tape per Fairline reader per week: a second run, or two
-- overlapping runs, add nothing (the unique key). p_force builds last week's
-- Tapes now, whatever the time (an operator's catch-up; the tests).
create or replace function public.fairline_tape_build(p_at timestamptz default now(), p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz text := public.fairline_rules() #>> '{tape,time_zone}';
  v_hour int := (public.fairline_rules() #>> '{tape,build_hour}')::int;
  v_local timestamp := p_at at time zone v_tz;
  w record;
  u record;
  v_id bigint;
  v_built int := 0;
  v_readers int := 0;
begin
  if not public.bet_checker_trusted() then
    raise exception 'fairline_tape_build is the scheduler''s alone' using errcode = '42501';
  end if;
  if not p_force and not (extract(isodow from v_local) = 1 and extract(hour from v_local) >= v_hour) then
    return jsonb_build_object('ok', true, 'due', false, 'local_time', to_char(v_local, 'Dy YYYY-MM-DD HH24:MI'), 'time_zone', v_tz);
  end if;
  select * into w from public.fairline_tape_week(p_at);
  perform pg_advisory_xact_lock(hashtext('fairline_tape_build'), hashtext(w.week_start::text));
  for u in
    select s.user_id from public.subscriptions s join auth.users au on au.id = s.user_id
     where public.fairline_paid(s.user_id, p_at)
       and not exists (select 1 from public.fairline_tapes t where t.user_id = s.user_id and t.week_start = w.week_start)
     order by s.user_id
  loop
    v_readers := v_readers + 1;
    insert into public.fairline_tapes (user_id, week_start, starts_at, ends_at, built_at, rules_version, tape)
    values (u.user_id, w.week_start, w.starts_at, w.ends_at, now(), public.fairline_rules() ->> 'version',
            public.fairline_tape_compute(u.user_id, w.starts_at, w.ends_at))
    on conflict on constraint fairline_tapes_once do nothing
    returning id into v_id;
    if v_id is not null then
      insert into public.fairline_tape_deliveries (tape_id, user_id) values (v_id, u.user_id);
      v_built := v_built + 1;
    end if;
    v_id := null;
  end loop;
  return jsonb_build_object('ok', true, 'due', true, 'week_start', w.week_start, 'starts_at', w.starts_at, 'ends_at', w.ends_at,
                            'built', v_built, 'readers', v_readers);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. THE EMAIL: claim, re-check NOW, mark (tools/fairline/tape_send.js)
-- ─────────────────────────────────────────────────────────────────────────────
-- p_now is the clock the re-checks read (Fairline at that moment, and the
-- email deadline); the sender passes none and gets now().
create or replace function public.fairline_tape_due(p_limit int default 25, p_now timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s public.lifecycle_settings%rowtype;
  v_on boolean;
  v_within int := (public.fairline_rules() #>> '{tape,email_within_hours}')::int;
  out jsonb := '[]'::jsonb;
  r record;
  t public.fairline_tapes%rowtype;
  v_skip text;
  v_email text;
  v_supp boolean;
  v_pref boolean;
  v_tok text;
  v_now timestamptz := coalesce(p_now, now());
begin
  if not public.bet_checker_trusted() then
    raise exception 'fairline_tape_due is the sender''s alone' using errcode = '42501';
  end if;
  select * into s from public.lifecycle_settings where id = 1;
  select email_enabled into v_on from public.fairline_tape_settings where id = 1;
  if not coalesce(s.sending_enabled, false) or not coalesce(v_on, false) then
    return jsonb_build_object('ok', true, 'sending_enabled', coalesce(s.sending_enabled, false),
                              'tape_email_enabled', coalesce(v_on, false), 'messages', '[]'::jsonb);
  end if;
  -- a row claimed by a job that died is released after 30 minutes
  update public.fairline_tape_deliveries set status = 'pending', updated_at = now()
   where status = 'sending' and claimed_at < now() - interval '30 minutes';
  for r in
    update public.fairline_tape_deliveries d set status = 'sending', claimed_at = now(), attempts = attempts + 1, updated_at = now()
     where d.id in (select id from public.fairline_tape_deliveries
                     where status in ('pending', 'failed') and attempts < 3
                     order by created_at, id for update skip locked limit greatest(1, least(coalesce(p_limit, 25), 100)))
    returning d.*
  loop
    v_skip := null;
    select * into t from public.fairline_tapes where id = r.tape_id;
    select u.email into v_email from auth.users u where u.id = r.user_id;
    select p.fairline_tape_emails into v_pref from public.user_preferences p where p.user_id = r.user_id;
    v_supp := false;
    if to_regclass('public.newsletter_suppressions') is not null and v_email is not null then
      begin
        execute 'select exists (select 1 from public.newsletter_suppressions where lower(email) = lower($1) and reason in (''bounce'', ''complaint''))'
          into v_supp using v_email;
      exception when others then v_supp := false;
      end;
    end if;
    if v_email is null or v_email !~ '@' then v_skip := 'no deliverable address';
    elsif v_supp then v_skip := 'address bounced or complained';
    elsif not coalesce(v_pref, true) then v_skip := 'reader turned The Tape emails off';
    elsif not public.fairline_paid(r.user_id, v_now) then v_skip := 'no longer a Fairline reader';
    elsif t.ends_at < v_now - make_interval(hours => v_within) then v_skip := 'too late to be useful';
    elsif coalesce((t.tape ->> 'quiet')::boolean, false) then v_skip := 'nothing to report this week';
    end if;
    if v_skip is not null then
      update public.fairline_tape_deliveries set status = 'skipped', skip_reason = v_skip, updated_at = now() where id = r.id;
      continue;
    end if;
    insert into public.lifecycle_tokens (user_id) values (r.user_id) on conflict (user_id) do nothing;
    select token into v_tok from public.lifecycle_tokens where user_id = r.user_id;
    out := out || jsonb_build_array(jsonb_build_object(
      'id', r.id, 'kind', 'fairline_tape', 'user_id', r.user_id, 'email', v_email, 'tape_id', t.id,
      'week_start', t.week_start, 'built_at', t.built_at, 'tape', t.tape, 'unsubscribe_token', v_tok));
  end loop;
  return jsonb_build_object('ok', true, 'sending_enabled', true, 'tape_email_enabled', true, 'from', s.from_email, 'reply_to', s.reply_to,
    'site_url', s.site_url, 'mailing_address', s.mailing_address, 'messages', out);
end;
$$;

create or replace function public.fairline_tape_mark(p_id bigint, p_status text, p_provider_id text default null, p_error text default null)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare n int;
begin
  if not public.bet_checker_trusted() then
    raise exception 'fairline_tape_mark is the sender''s alone' using errcode = '42501';
  end if;
  if p_status not in ('sent', 'failed', 'skipped', 'release') then return false; end if;
  -- a dry run gives the row back exactly as it was: pending, attempt uncounted
  if p_status = 'release' then
    update public.fairline_tape_deliveries set status = 'pending', attempts = greatest(0, attempts - 1), claimed_at = null, updated_at = now()
     where id = p_id and status = 'sending';
    get diagnostics n = row_count;
    return n > 0;
  end if;
  update public.fairline_tape_deliveries
     set status = p_status, provider_id = left(p_provider_id, 120), last_error = left(p_error, 400),
         skip_reason = case when p_status = 'skipped' then left(p_error, 200) else skip_reason end,
         sent_at = case when p_status = 'sent' then now() else sent_at end, updated_at = now()
   where id = p_id and status = 'sending';
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

-- The link in every Tape email. Anyone holding it may only turn The Tape
-- emails OFF; it returns only { ok }, never whose token it was.
create or replace function public.fairline_tape_unsubscribe(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_uid uuid;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  select user_id into v_uid from public.lifecycle_tokens where token = p_token;
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'unknown'); end if;
  insert into public.user_preferences (user_id, fairline_tape_emails) values (v_uid, false)
  on conflict (user_id) do update set fairline_tape_emails = false;
  update public.fairline_tape_deliveries set status = 'skipped', skip_reason = 'reader turned The Tape emails off', updated_at = now()
   where user_id = v_uid and status in ('pending', 'failed');
  return jsonb_build_object('ok', true);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. THE PAGE
-- ─────────────────────────────────────────────────────────────────────────────
-- The caller's own opt-in / opt-out. A preference, not a paid feature: it is
-- the caller's, paid or not.
create or replace function public.fairline_tape_email(p_on boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'fairline: sign in first' using errcode = '42501'; end if;
  if p_on is null then raise exception 'fairline_tape_email: on or off' using errcode = '22023'; end if;
  insert into public.user_preferences (user_id, fairline_tape_emails) values (v_user, p_on)
  on conflict (user_id) do update set fairline_tape_emails = p_on;
  if not p_on then
    update public.fairline_tape_deliveries set status = 'skipped', skip_reason = 'reader turned The Tape emails off', updated_at = now()
     where user_id = v_user and status in ('pending', 'failed');
  end if;
  return jsonb_build_object('ok', true, 'on', p_on);
end;
$$;

-- The caller's Tapes, newest first. Paid only: a free (or lapsed) account
-- gets when the next one is built and no figure at all.
create or replace function public.fairline_tapes()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_pref boolean;
  v_sending boolean;
  v_on boolean;
  v_email jsonb;
begin
  if v_user is null then raise exception 'fairline: sign in first' using errcode = '42501'; end if;
  select p.fairline_tape_emails into v_pref from public.user_preferences p where p.user_id = v_user;
  select sending_enabled into v_sending from public.lifecycle_settings where id = 1;
  select email_enabled into v_on from public.fairline_tape_settings where id = 1;
  v_email := jsonb_build_object('mine', coalesce(v_pref, true), 'delivering', coalesce(v_sending, false) and coalesce(v_on, false));
  if not public.fairline_paid(v_user, now()) then
    return jsonb_build_object('paid', false, 'next_at', public.fairline_tape_next(now()), 'email', v_email,
                              'rules', jsonb_build_object('tape', public.fairline_rules() -> 'tape'));
  end if;
  return jsonb_build_object('paid', true, 'as_of', now(), 'next_at', public.fairline_tape_next(now()), 'email', v_email,
    'rules', jsonb_build_object('tape', public.fairline_rules() -> 'tape', 'min_sample_bets', public.fairline_rules() -> 'min_sample_bets'),
    'tapes', coalesce((
      select jsonb_agg(jsonb_build_object('week_start', t.week_start, 'starts_at', t.starts_at, 'ends_at', t.ends_at, 'built_at', t.built_at,
                         'tape', t.tape,
                         'email', jsonb_strip_nulls(jsonb_build_object('status', d.status, 'skip_reason', d.skip_reason, 'sent_at', d.sent_at)))
             order by t.week_start desc)
        from (select * from public.fairline_tapes x where x.user_id = v_user
               order by x.week_start desc limit (public.fairline_rules() #>> '{tape,history_weeks}')::int) t
        left join public.fairline_tape_deliveries d on d.tape_id = t.id), '[]'::jsonb));
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. GRANTS
-- ─────────────────────────────────────────────────────────────────────────────
-- A Supabase project grants EXECUTE on every new public function to anon and
-- authenticated by default; revoking from PUBLIC alone leaves those in place.
revoke all on function public.fairline_tape_compute(uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.fairline_tape_build(timestamptz, boolean) from public, anon, authenticated;
revoke all on function public.fairline_tape_due(int, timestamptz) from public, anon, authenticated;
revoke all on function public.fairline_tape_mark(bigint, text, text, text) from public, anon, authenticated;
revoke all on function public.fairline_tapes_guard() from public, anon, authenticated;
revoke all on function public.fairline_tape_unsubscribe(text) from public;
revoke all on function public.fairline_tape_email(boolean) from public, anon;
revoke all on function public.fairline_tapes() from public, anon;
grant execute on function public.fairline_tape_unsubscribe(text) to anon, authenticated;
grant execute on function public.fairline_tape_email(boolean), public.fairline_tapes() to authenticated;
grant execute on function public.fairline_tape_week(timestamptz), public.fairline_tape_next(timestamptz) to anon, authenticated;
do $g$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.fairline_tape_compute(uuid, timestamptz, timestamptz), '
         || 'public.fairline_tape_build(timestamptz, boolean), public.fairline_tape_due(int, timestamptz), '
         || 'public.fairline_tape_mark(bigint, text, text, text), public.fairline_tape_week(timestamptz), '
         || 'public.fairline_tape_next(timestamptz) to service_role';
  end if;
end
$g$;

notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- THE REPORT. Every row should say ok.
-- ─────────────────────────────────────────────────────────────────────────────
select piece, state from (
  select '01 a Tape is append-only (no update, no truncate, no delete while its reader exists)' as piece,
         case when (select count(*) from pg_trigger where tgrelid = 'public.fairline_tapes'::regclass
                     and tgname in ('fairline_tapes_no_update', 'fairline_tapes_no_truncate') and not tgisinternal) = 2
              then 'ok' else 'CHECK THIS' end as state
  union all select '02 one Tape per reader per week',
         case when exists (select 1 from pg_constraint where conname = 'fairline_tapes_once') then 'ok' else 'CHECK THIS' end
  union all select '03 no client role reads a Tape, a delivery or the settings directly',
         case when not has_table_privilege('anon', 'public.fairline_tapes', 'select') and not has_table_privilege('authenticated', 'public.fairline_tapes', 'select')
               and not has_table_privilege('authenticated', 'public.fairline_tape_deliveries', 'select')
               and not has_table_privilege('authenticated', 'public.fairline_tape_settings', 'select')
              then 'ok' else 'CHECK THIS' end
  union all select '04 building, claiming and marking are the scheduler''s and the sender''s alone',
         case when not exists (select 1 from unnest(array['public.fairline_tape_build(timestamptz,boolean)', 'public.fairline_tape_due(integer,timestamp with time zone)',
                                                           'public.fairline_tape_mark(bigint,text,text,text)', 'public.fairline_tape_compute(uuid,timestamptz,timestamptz)']) f
                                cross join unnest(array['anon', 'authenticated']) g where has_function_privilege(g, f, 'execute'))
              then 'ok' else 'CHECK THIS' end
  union all select '05 the page reads Tapes through the one gate, fairline_paid()',
         case when pg_get_functiondef('public.fairline_tapes()'::regprocedure) like '%public.fairline_paid(%'
               and not has_function_privilege('anon', 'public.fairline_tapes()', 'execute')
              then 'ok' else 'CHECK THIS' end
  union all select '06 a reader can turn The Tape emails off from the email link, signed out',
         case when has_function_privilege('anon', 'public.fairline_tape_unsubscribe(text)', 'execute') then 'ok' else 'CHECK THIS' end
  union all select '07 Tape email is ' || case when (select email_enabled from public.fairline_tape_settings where id = 1) then 'ON' else 'off' end
         || ', the email pipeline is ' || case when (select sending_enabled from public.lifecycle_settings where id = 1) then 'ON' else 'off' end
         || ' (both must be on to send)',
         'ok'
  union all select '08 Tapes on file (readers, weeks)',
         'ok (' || (select count(distinct user_id) from public.fairline_tapes)::text || ', '
                || (select count(distinct week_start) from public.fairline_tapes)::text || ')'
) r order by 1;
