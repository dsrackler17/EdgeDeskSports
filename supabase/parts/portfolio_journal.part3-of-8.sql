-- portfolio_journal -- part 3 of 8.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RULES AND EXPERIMENTS — the reader's own, never retroactive
-- ─────────────────────────────────────────────────────────────────────────────
-- a rule's parameters are numbers where numbers are meant, checked on the way
-- in: a malformed one could never be evaluated
create or replace function public.portfolio_rule_params_ok(p_kind text, p_params jsonb)
returns boolean language sql immutable as $$
  select case p_kind
    when 'MAX_STAKE_UNITS' then jsonb_typeof(p_params->'units') = 'number' and (p_params->>'units')::numeric > 0
    when 'MAX_DAILY_UNITS' then jsonb_typeof(p_params->'units') = 'number' and (p_params->>'units')::numeric > 0
    when 'MAX_POSITIONS_PER_DAY' then jsonb_typeof(p_params->'count') = 'number' and (p_params->>'count')::numeric >= 1
    when 'MIN_MODEL_EDGE' then jsonb_typeof(p_params->'ev') = 'number' and (p_params->>'ev')::numeric between -1 and 1
    when 'ODDS_BETWEEN' then coalesce(jsonb_typeof(p_params->'min'), 'number') = 'number' and coalesce(jsonb_typeof(p_params->'max'), 'number') = 'number'
                             and (p_params ? 'min' or p_params ? 'max')
                             and coalesce((p_params->>'min')::numeric, 1) <= coalesce((p_params->>'max')::numeric, 10001)
    when 'MIN_LEAD_HOURS' then jsonb_typeof(p_params->'hours') = 'number' and (p_params->>'hours')::numeric between 0 and 8760
    when 'ONLY_SPORTS' then jsonb_typeof(p_params->'sports') = 'array' and jsonb_array_length(p_params->'sports') between 1 and 30
    else true end
$$;

create table if not exists public.portfolio_rules (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  kind          text        not null,
  params        jsonb       not null default '{}'::jsonb,
  label         text        not null,
  active_from   timestamptz not null default now(),
  active_until  timestamptz null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint portfolio_rules_kind check (kind in ('MAX_STAKE_UNITS', 'MAX_DAILY_UNITS', 'MAX_POSITIONS_PER_DAY', 'MIN_MODEL_EDGE',
    'ODDS_BETWEEN', 'NO_LIVE', 'MIN_LEAD_HOURS', 'NO_PARLAYS', 'ONLY_SPORTS', 'REQUIRE_PLANNED', 'REQUIRE_THESIS')),
  constraint portfolio_rules_params check (jsonb_typeof(params) = 'object' and pg_column_size(params) <= 2048
    and public.portfolio_rule_params_ok(kind, params)),
  constraint portfolio_rules_label check (length(btrim(label)) between 1 and 120),
  constraint portfolio_rules_window check (active_until is null or active_until >= active_from)
);
create index if not exists portfolio_rules_user on public.portfolio_rules (user_id, active_from);

-- a rule means what it meant when it was adopted: its kind, parameters and
-- start are frozen; it can be renamed, and retired once (to change a rule,
-- retire it and adopt a new one)
create or replace function public.portfolio_rules_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then new.user_id := auth.uid(); new.active_from := now(); new.active_until := null; end if;
    new.created_at := now();
  else
    new.id := old.id; new.user_id := old.user_id; new.created_at := old.created_at;
    new.kind := old.kind; new.params := old.params; new.active_from := old.active_from;
    if old.active_until is not null then new.active_until := old.active_until; end if;
    if new.active_until is not null and new.active_until < new.active_from then new.active_until := new.active_from; end if;
  end if;
  new.label := btrim(new.label);
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists portfolio_rules_guard_trg on public.portfolio_rules;
create trigger portfolio_rules_guard_trg before insert or update on public.portfolio_rules
  for each row execute function public.portfolio_rules_guard();

create table if not exists public.portfolio_experiments (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  title         text        not null,
  hypothesis    text        null,
  metric        text        not null,
  condition     jsonb       not null default '{}'::jsonb,
  starts_at     timestamptz not null default now(),
  ends_at       timestamptz not null,
  min_sample    int         not null default 20,
  status        text        not null default 'ACTIVE',
  ended_at      timestamptz null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint portfolio_experiments_metric check (metric in ('CLV', 'PROCESS', 'ROI')),
  constraint portfolio_experiments_condition check (jsonb_typeof(condition) = 'object' and pg_column_size(condition) <= 2048),
  constraint portfolio_experiments_text check (length(btrim(title)) between 1 and 120 and coalesce(length(hypothesis), 0) <= 500),
  constraint portfolio_experiments_window check (ends_at > starts_at and ends_at <= starts_at + interval '366 days'),
  constraint portfolio_experiments_sample check (min_sample between 5 and 1000),
  constraint portfolio_experiments_status check (status in ('ACTIVE', 'ENDED', 'ABANDONED'))
);
create index if not exists portfolio_experiments_user on public.portfolio_experiments (user_id, starts_at desc);

-- pre-registered: what is measured, on what, and over which window cannot be
-- changed once the experiment exists — only ended early or abandoned
create or replace function public.portfolio_experiments_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then new.user_id := auth.uid(); new.starts_at := greatest(new.starts_at, now() - interval '1 minute'); end if;
    new.status := 'ACTIVE'; new.ended_at := null; new.created_at := now();
  else
    new.id := old.id; new.user_id := old.user_id; new.created_at := old.created_at;
    new.metric := old.metric; new.condition := old.condition; new.starts_at := old.starts_at; new.ends_at := old.ends_at;
    new.min_sample := old.min_sample;
    if old.status <> 'ACTIVE' then new.status := old.status; new.ended_at := old.ended_at;
    elsif new.status <> 'ACTIVE' then new.ended_at := least(now(), old.ends_at); end if;
  end if;
  new.title := btrim(new.title);
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists portfolio_experiments_guard_trg on public.portfolio_experiments;
create trigger portfolio_experiments_guard_trg before insert or update on public.portfolio_experiments
  for each row execute function public.portfolio_experiments_guard();

-- one rule against one position: FOLLOWED, BROKEN, or UNKNOWN when the data
-- the rule needs was never recorded (an unknown is never counted either way)
create or replace function public.portfolio_rule_verdict(p_kind text, p_params jsonb, p_units numeric, p_day_units numeric, p_day_count int,
    p_model_ev numeric, p_entry_dec numeric, p_lead_seconds bigint, p_position_type text, p_sport text, p_planned boolean, p_thesis boolean)
returns text language sql immutable as $$
  select case p_kind
    when 'MAX_STAKE_UNITS' then case when p_units is null or (p_params->>'units') is null then 'UNKNOWN'
                                     when p_units <= (p_params->>'units')::numeric then 'FOLLOWED' else 'BROKEN' end
    when 'MAX_DAILY_UNITS' then case when p_day_units is null or (p_params->>'units') is null then 'UNKNOWN'
                                     when p_day_units <= (p_params->>'units')::numeric then 'FOLLOWED' else 'BROKEN' end
    when 'MAX_POSITIONS_PER_DAY' then case when p_day_count is null or (p_params->>'count') is null then 'UNKNOWN'
                                     when p_day_count <= (p_params->>'count')::numeric then 'FOLLOWED' else 'BROKEN' end
    when 'MIN_MODEL_EDGE' then case when p_model_ev is null or (p_params->>'ev') is null then 'UNKNOWN'
                                     when p_model_ev >= (p_params->>'ev')::numeric then 'FOLLOWED' else 'BROKEN' end
    when 'ODDS_BETWEEN' then case when p_entry_dec is null then 'UNKNOWN'
                                  when p_entry_dec >= coalesce((p_params->>'min')::numeric, 1) and p_entry_dec <= coalesce((p_params->>'max')::numeric, 10001)
                                  then 'FOLLOWED' else 'BROKEN' end
    when 'NO_LIVE' then case when p_lead_seconds is null then 'UNKNOWN' when p_lead_seconds > 0 then 'FOLLOWED' else 'BROKEN' end
    when 'MIN_LEAD_HOURS' then case when p_lead_seconds is null or (p_params->>'hours') is null then 'UNKNOWN'
                                    when p_lead_seconds >= (p_params->>'hours')::numeric * 3600 then 'FOLLOWED' else 'BROKEN' end
    when 'NO_PARLAYS' then case when p_position_type in ('PARLAY', 'SAME_GAME_PARLAY') then 'BROKEN' else 'FOLLOWED' end
    when 'ONLY_SPORTS' then case when p_sport is null or jsonb_typeof(p_params->'sports') <> 'array' then 'UNKNOWN'
                                 when upper(p_sport) in (select upper(x) from jsonb_array_elements_text(p_params->'sports') x) then 'FOLLOWED' else 'BROKEN' end
    when 'REQUIRE_PLANNED' then case when p_planned is null then 'UNKNOWN' when p_planned then 'FOLLOWED' else 'BROKEN' end
    when 'REQUIRE_THESIS' then case when p_thesis then 'FOLLOWED' else 'BROKEN' end
    else 'UNKNOWN' end
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. THE FACTS — every position the caller owns that was placed or settled in
--    the window, with its timing, prices, units, session, the result that
--    came before it, its rule verdicts and its process components. Runs as
--    the caller: row level security decides what it can see.
-- ─────────────────────────────────────────────────────────────────────────────
-- the reader's zone: as asked, else their saved preference, else UTC; an
-- unknown zone is an error, never a silent UTC
create or replace function public.portfolio_tz(p_tz text)
returns text language plpgsql stable as $$
declare z text := nullif(btrim(coalesce(p_tz, '')), '');
begin
  if z is null and to_regclass('public.user_preferences') is not null and auth.uid() is not null then
    begin
      execute 'select nullif(btrim(timezone), '''') from public.user_preferences where user_id = $1' into z using auth.uid();
    exception when undefined_column then z := null;
    end;
  end if;
  z := coalesce(z, 'UTC');
  if length(z) > 64 or z !~ '^[A-Za-z0-9_+/-]+$' then
    raise exception 'portfolio: unknown time zone %', left(z, 64) using errcode = '22023';
  end if;
  begin
    perform now() at time zone z;
  exception when invalid_parameter_value then
    raise exception 'portfolio: unknown time zone %', z using errcode = '22023';
  end;
  return z;
end $$;
