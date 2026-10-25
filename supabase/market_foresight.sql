-- =============================================================================
-- market_foresight.sql — EdgeDesk Market Foresight: which forecasts and which
-- observed venues preceded subsequent market movement. A separate,
-- observational research layer: versioned derived measurements, behind
-- server-enforced doors. docs/market-foresight/README.md (architecture),
-- docs/market-foresight/METHODOLOGY.md and
-- research/foresight/methodology/mf-v1.json (the frozen rules).
--
-- ISOLATION. Nothing here reads or writes a ranking, a grade, an evaluation
-- window, an eligibility rule, a model input or a historical forecast. It
-- creates mf_* objects only. The only foreign objects it READS are, in doors,
-- collective.models / collective.creators (is a model still listed?) and
-- public.kalshi_markets / kalshi_game_links (the rules texts an operator
-- verifies); each is read only if installed, and a missing one fails closed.
-- tools/foresight/isolation.test.js proves no ranking or grading object
-- references this layer.
--
-- WHAT IT ADDS
--   mf_config / mf_config_log      mode (off | shadow | live), whether anyone
--                                  may see full timelines; every change logged
--   mf_methodologies               APPEND-ONLY: each frozen methodology version
--                                  with its file's sha256. A different digest
--                                  under an existing version is refused
--   mf_runs                        one row per derivation run (a lease)
--   mf_games / mf_game_versions    one current row per (methodology, game);
--                                  every distinct input hash kept, append-only
--   mf_units / mf_unit_versions    one current row per measurement unit (the
--                                  first eligible forecast per model version,
--                                  game, market and venue); history append-only
--   mf_summaries                   the latest run's summaries (re-derivable
--                                  from the units at any time)
--   mf_settlement_verifications    APPEND-ONLY: an operator's reading of a
--                                  Kalshi series' rules text (by sha256). Until
--                                  one exists, Kalshi is never compared
--
-- WRITES. No client role writes any table; the service role writes only
-- through the job doors (table DML is revoked from it too):
--   mf_job_begin(p) -> run (or busy)    mf_job_known(version)
--   mf_job_verifications()              mf_job_put_games(run, rows)
--   mf_job_put_units(run, rows)         mf_job_put_summaries(run, rows)
--   mf_job_finish(run, p)
-- Every put is idempotent: a row whose input hash is already current changes
-- nothing but its last-seen run; a new hash appends a version and replaces the
-- current row. The fixture namespace (SYN_ events, syn_ models) is refused.
--
-- READS. Row level security with no client policy; SELECT revoked. Doors:
--   anyone             mf_status() (mode, coverage, freshness: no forecast)
--   anyone, when live  mf_overview(filters), mf_games_list(filters, cursor,
--                      limit), mf_game(sport, event), mf_model(filters,
--                      cursor, limit), mf_embed(source, model): derived
--                      measurements of PUBLISHABLE models only. A Collective
--                      model is publishable while it and its creator are
--                      listed and the creator is active (checked at read
--                      time, fail closed). Consensus membership is never
--                      named publicly.
--   Full Access        the full per-game timeline (every observation segment
--                      with raw prices), unless mf_config.public_timeline
--   operators          mf_admin_set_mode, mf_admin_set_public_timeline,
--                      mf_admin_runs, mf_admin_pending_rules,
--                      mf_admin_verify_settlement (billing_is_admin, fail
--                      closed); operators see shadow data
--   the owner          mf_owner_set_mode (no API role: SQL editor / workflow)
--
-- SHADOW FIRST. mode starts 'shadow'. 'off' is the rollback switch: every
-- reader door answers {mode: off} and nothing else, and no source data
-- anywhere is touched.
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- Mirrored in supabase/migrations/20261025120000_market_foresight.sql.
-- CORE POSTGRES ONLY: sha256(bytea) and gen_random_uuid(), no extension.
-- =============================================================================

begin;

-- ---------------------------------------------------------------- guards
create or replace function public.mf_keep()
returns trigger language plpgsql as $$
begin
  raise exception 'public.% is append-only: % refused (history is kept; write a new row instead)', tg_table_name, tg_op;
end $$;

-- ---------------------------------------------------------------- who is asking
create or replace function public.mf_viewer_entitled()
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid; ok boolean;
begin
  begin uid := auth.uid(); exception when others then return false; end;
  if uid is null then return false; end if;
  if to_regprocedure('public.community_is_entitled(uuid)') is not null then
    execute 'select public.community_is_entitled($1)' into ok using uid;
    return coalesce(ok, false);
  end if;
  if to_regclass('public.subscriptions') is not null and to_regprocedure('public.billing_row_grants_access(text,text,timestamptz,timestamptz)') is not null then
    execute 'select exists (select 1 from public.subscriptions s where s.user_id = $1 and public.billing_row_grants_access(s.status, s.price_id, s.current_period_end, now()))' into ok using uid;
    return coalesce(ok, false);
  end if;
  return false;
end $$;

create or replace function public.mf_is_admin()
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v boolean := false;
begin
  if auth.uid() is null then return false; end if;
  if to_regprocedure('public.billing_is_admin()') is not null then
    execute 'select public.billing_is_admin()' into v; return coalesce(v, false);
  end if;
  if to_regprocedure('public.affiliate_is_admin()') is not null then
    execute 'select public.affiliate_is_admin()' into v; return coalesce(v, false);
  end if;
  return false;
exception when others then return false;
end $$;

-- ---------------------------------------------------------------- config
create table if not exists public.mf_config (
  key         text primary key check (key ~ '^[a-z_]{2,40}$'),
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);
create table if not exists public.mf_config_log (
  id          bigint generated always as identity primary key,
  key         text not null,
  old_value   jsonb,
  new_value   jsonb not null,
  changed_by  uuid,
  reason      text,
  changed_at  timestamptz not null default now()
);
insert into public.mf_config (key, value) values
  ('mode', '"shadow"'),
  ('public_timeline', 'false'),
  ('sports', '["nfl","cfb"]')
on conflict (key) do nothing;

create or replace function public.mf_cfg(p_key text)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select value from public.mf_config where key = p_key;
$$;
create or replace function public.mf_mode()
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select value #>> '{}' from public.mf_config where key = 'mode'), 'off');
$$;
-- the reader's position, decided once
create or replace function public.mf_reader()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare m text := public.mf_mode(); adm boolean := public.mf_is_admin(); ent boolean := public.mf_viewer_entitled();
        pub boolean := coalesce((public.mf_cfg('public_timeline'))::text = 'true', false);
begin
  return jsonb_build_object('mode', m, 'admin', adm, 'entitled', ent, 'signed_in', auth.uid() is not null,
    'can_read', adm or m = 'live', 'full_access', adm or (m = 'live' and (ent or pub)));
end $$;

-- ---------------------------------------------------------------- methodologies (append-only)
create table if not exists public.mf_methodologies (
  version        text primary key check (version ~ '^mf-v[0-9]+$'),
  sha256         text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  spec           jsonb not null,
  frozen_at      date,
  registered_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- runs
create table if not exists public.mf_runs (
  run_id               uuid primary key default gen_random_uuid(),
  methodology_version  text not null references public.mf_methodologies (version),
  trigger              text not null default 'cron' check (trigger in ('cron', 'manual', 'test')),
  engine               text,
  status               text not null default 'running' check (status in ('running', 'ok', 'partial', 'failed')),
  started_at           timestamptz not null default now(),
  finished_at          timestamptz,
  sources              jsonb not null default '{}'::jsonb,
  counts               jsonb not null default '{}'::jsonb,
  log                  jsonb not null default '[]'::jsonb,
  coverage             jsonb not null default '[]'::jsonb,
  lead_lag             jsonb not null default '[]'::jsonb,
  incremental          jsonb not null default '[]'::jsonb,
  error                text,
  check (finished_at is null or finished_at >= started_at)
);
create index if not exists mf_runs_started_idx on public.mf_runs (started_at desc);

-- a run is finished once; nothing else on it changes and it is never deleted
create or replace function public.mf_runs_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'public.mf_runs is kept: delete refused'; end if;
  if old.status <> 'running' then raise exception 'public.mf_runs: run % is already %, it cannot change', old.run_id, old.status; end if;
  if new.run_id <> old.run_id or new.methodology_version <> old.methodology_version or new.started_at <> old.started_at or new.trigger <> old.trigger then
    raise exception 'public.mf_runs: a run''s identity cannot change';
  end if;
  return new;
end $$;
drop trigger if exists mf_runs_guarded on public.mf_runs;
create trigger mf_runs_guarded before update or delete on public.mf_runs for each row execute function public.mf_runs_guard();

-- ---------------------------------------------------------------- games
create table if not exists public.mf_games (
  methodology_version  text not null references public.mf_methodologies (version),
  sport                text not null check (sport in ('nfl', 'cfb')),
  event_id             text not null check (event_id <> '' and event_id !~ '^SYN_'),
  kickoff              timestamptz not null,
  home                 text,
  away                 text,
  state                text,
  has_kalshi           boolean not null default false,
  n_units              integer not null default 0,
  n_measured           integer not null default 0,
  input_hash           text not null check (input_hash ~ '^mfi-[0-9a-f]{16}$'),
  payload              jsonb not null,
  first_run            uuid not null,
  last_run             uuid not null,
  computed_at          timestamptz not null default now(),
  primary key (methodology_version, sport, event_id)
);
create index if not exists mf_games_kickoff_idx on public.mf_games (methodology_version, kickoff desc, sport, event_id);
create index if not exists mf_games_sport_kickoff_idx on public.mf_games (methodology_version, sport, kickoff desc);

create table if not exists public.mf_game_versions (
  id                   bigint generated always as identity primary key,
  methodology_version  text not null,
  sport                text not null,
  event_id             text not null,
  input_hash           text not null,
  payload              jsonb not null,
  run_id               uuid not null,
  created_at           timestamptz not null default now(),
  unique (methodology_version, sport, event_id, input_hash)
);

-- ---------------------------------------------------------------- units
create table if not exists public.mf_units (
  methodology_version  text not null references public.mf_methodologies (version),
  unit_key             text not null check (unit_key ~ '^mfu-[0-9a-f]{16}$'),
  sport                text not null check (sport in ('nfl', 'cfb')),
  event_id             text not null check (event_id <> '' and event_id !~ '^SYN_'),
  kickoff              timestamptz not null,
  source               text not null check (source in ('edgedesk', 'collective', 'collective_consensus')),
  model_key            text not null check (model_key <> '' and model_key !~ '^syn_'),
  model_label          text,
  model_version        text not null,
  creator              text,
  market               text not null check (market in ('spread', 'total', 'moneyline')),
  measure              text not null check (measure in ('line_points', 'probability')),
  venue                text not null check (venue in ('draftkings', 'kalshi')),
  status               text not null check (status in ('measured', 'excluded')),
  exclusion_reason     text,
  cls                  text,
  precedence           text,
  horizon_bucket       text,
  published_at         timestamptz,
  input_hash           text not null check (input_hash ~ '^mfh-[0-9a-f]{16}$'),
  payload              jsonb not null,
  first_run            uuid not null,
  last_run             uuid not null,
  updated_at           timestamptz not null default now(),
  primary key (methodology_version, unit_key),
  check ((status = 'excluded') = (exclusion_reason is not null)),
  check ((market = 'moneyline') = (measure = 'probability')),
  check (venue = 'draftkings' or market = 'moneyline')
);
create index if not exists mf_units_model_idx on public.mf_units (methodology_version, source, model_key, model_version, kickoff desc, unit_key);
create index if not exists mf_units_game_idx on public.mf_units (methodology_version, sport, event_id);
create index if not exists mf_units_status_idx on public.mf_units (methodology_version, status, exclusion_reason);

create table if not exists public.mf_unit_versions (
  id                   bigint generated always as identity primary key,
  methodology_version  text not null,
  unit_key             text not null,
  input_hash           text not null,
  payload              jsonb not null,
  run_id               uuid not null,
  created_at           timestamptz not null default now(),
  unique (methodology_version, unit_key, input_hash)
);

-- ---------------------------------------------------------------- summaries (re-derivable)
create table if not exists public.mf_summaries (
  methodology_version  text not null references public.mf_methodologies (version),
  window_key           text not null check (window_key in ('all', '30d', '7d')),
  key                  text not null,
  source               text not null,
  model_key            text not null,
  model_label          text,
  model_version        text not null,
  sport                text not null,
  market               text not null,
  venue                text not null,
  horizon_bucket       text not null,
  evidence             text not null,
  payload              jsonb not null,
  run_id               uuid not null,
  primary key (methodology_version, window_key, key)
);
create index if not exists mf_summaries_model_idx on public.mf_summaries (methodology_version, source, model_key, model_version);

-- ---------------------------------------------------------------- settlement verifications (append-only)
create table if not exists public.mf_settlement_verifications (
  id             bigint generated always as identity primary key,
  series_ticker  text not null check (series_ticker ~ '^[A-Z0-9]{2,40}$'),
  sport          text not null check (sport in ('nfl', 'cfb')),
  rules_sha256   text not null check (rules_sha256 ~ '^[0-9a-f]{64}$'),
  overtime       text not null check (overtime in ('included', 'excluded')),
  tie            text not null check (tie in ('push', 'two_way_conditional', 'impossible', 'no', 'other')),
  cancellation   text,
  rules_excerpt  text,
  note           text,
  verified_by    uuid,
  verified_at    timestamptz not null default now()
);
create index if not exists mf_settlement_verifications_idx on public.mf_settlement_verifications (series_ticker, rules_sha256, id desc);

-- history is kept
do $t$ declare t text; begin
  foreach t in array array['mf_config_log', 'mf_methodologies', 'mf_game_versions', 'mf_unit_versions', 'mf_settlement_verifications'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_frozen', t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.mf_keep()', t || '_frozen', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.mf_keep()', t || '_no_truncate', t);
  end loop;
  foreach t in array array['mf_runs', 'mf_games', 'mf_units'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.mf_keep()', t || '_no_truncate', t);
  end loop;
end $t$;

comment on table public.mf_units is 'Market Foresight (T2 Computed): one measurement unit per first eligible forecast, model version, game, market and venue. Derived only; never read by a ranking, grade or model.';
comment on table public.mf_settlement_verifications is 'An operator''s reading of a Kalshi series'' rules text, by sha256. Kalshi is compared with nothing until a matching record exists.';

-- ---------------------------------------------------------------- visibility
-- A Collective model is publishable while the model and its creator are
-- listed and the creator is active and not removed. Read live, through
-- whatever columns production has (to_jsonb), and fail closed.
create or replace function public.mf_collective_visible(p_model_key text)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare ok boolean;
begin
  if p_model_key is null or p_model_key !~ '^collective:[0-9a-fA-F-]{36}$' then return false; end if;
  if to_regclass('collective.models') is null or to_regclass('collective.creators') is null then return false; end if;
  begin
    execute 'select exists (select 1 from collective.models m join collective.creators c on c.id = m.creator_id
              where m.id::text = $1
                and coalesce((to_jsonb(m) ->> ''is_listed'')::boolean, false)
                and coalesce((to_jsonb(c) ->> ''is_listed'')::boolean, false)
                and (to_jsonb(c) ->> ''removed_at'') is null
                and coalesce(to_jsonb(c) ->> ''status'', to_jsonb(c) ->> ''account_status'', ''active'') = ''active'')'
      into ok using substr(p_model_key, 12);
  exception when others then return false;
  end;
  return coalesce(ok, false);
end $$;

create or replace function public.mf_visible(p_source text, p_model_key text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select case p_source when 'edgedesk' then true when 'collective_consensus' then true
                       when 'collective' then public.mf_collective_visible(p_model_key) else false end;
$$;

-- consensus members are never named outside the operators' view
create or replace function public.mf_strip_members(p jsonb)
returns jsonb language sql immutable as $$
  select case when p ? 'membership' and jsonb_typeof(p -> 'membership') = 'object'
              then jsonb_set(p, '{membership}', coalesce((select jsonb_object_agg(k, v - 'members') from jsonb_each(p -> 'membership') e (k, v)), '{}'::jsonb))
              else p end;
$$;

-- one unit as a reader may see it
create or replace function public.mf_unit_out(u public.mf_units, p_admin boolean)
returns jsonb language sql stable as $$
  select case when p_admin then u.payload else public.mf_strip_members(u.payload) end
         || jsonb_build_object('unit_key', u.unit_key, 'status', u.status, 'exclusion_reason', u.exclusion_reason);
$$;

-- a game's payload as a reader may see it: forecasts of unpublishable models
-- are dropped, consensus members are not named, and without full access the
-- observation segments are replaced by their coverage
create or replace function public.mf_game_out(p jsonb, p_full boolean, p_admin boolean)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare out jsonb := p; fc jsonb; cons jsonb; ser jsonb := '{}'::jsonb; k text; v jsonb;
begin
  select coalesce(jsonb_agg(f), '[]'::jsonb) into fc from jsonb_array_elements(coalesce(p -> 'forecasts', '[]'::jsonb)) f
   where p_admin or public.mf_visible(f ->> 'source', f ->> 'model_key');
  out := jsonb_set(out, '{forecasts}', fc);
  if not p_admin then
    select coalesce(jsonb_agg(jsonb_set(c, '{markets}', coalesce((select jsonb_object_agg(mk, mv - 'members') from jsonb_each(c -> 'markets') e (mk, mv)), '{}'::jsonb))), '[]'::jsonb)
      into cons from jsonb_array_elements(coalesce(p -> 'consensus', '[]'::jsonb)) c;
    out := jsonb_set(out, '{consensus}', cons);
  end if;
  if not p_full then
    for k, v in select * from jsonb_each(coalesce(p -> 'series', '{}'::jsonb)) loop
      ser := ser || jsonb_build_object(k, (v - 'segments') || jsonb_build_object('segments_locked', true, 'n_segments', jsonb_array_length(coalesce(v -> 'segments', '[]'::jsonb))));
    end loop;
    out := jsonb_set(out, '{series}', ser);
    out := out - 'lead_lag' || jsonb_build_object('lead_lag', case when p -> 'lead_lag' ? 'pairs'
             then jsonb_build_object('status', p -> 'lead_lag' -> 'status', 'locked', true, 'n_pairs', jsonb_array_length(p -> 'lead_lag' -> 'pairs'))
             else p -> 'lead_lag' end);
  end if;
  return out;
end $$;

create or replace function public.mf_current_version()
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select r.methodology_version from public.mf_runs r where r.status in ('ok', 'partial') order by r.started_at desc limit 1),
                  (select m.version from public.mf_methodologies m order by m.registered_at desc limit 1));
$$;

create or replace function public.mf_cursor_in(p text)
returns jsonb language plpgsql immutable as $$
begin
  if p is null or p = '' then return null; end if;
  return convert_from(decode(p, 'base64'), 'UTF8')::jsonb;
exception when others then raise exception 'mf: a malformed cursor was refused';
end $$;
create or replace function public.mf_cursor_out(p jsonb)
returns text language sql immutable as $$
  select translate(encode(convert_to(p::text, 'UTF8'), 'base64'), E'\n', '');
$$;

-- ---------------------------------------------------------------- the job's doors (service_role)
create or replace function public.mf_job_begin(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare m jsonb := p -> 'methodology'; v text := m ->> 'version'; d text := m ->> 'sha256'; have text; busy uuid; rid uuid;
begin
  if v is null or d is null or (m -> 'spec') is null then raise exception 'mf_job_begin: methodology version, sha256 and spec are required'; end if;
  select sha256 into have from public.mf_methodologies where version = v;
  if have is null then
    if (m -> 'spec' ->> 'version') is distinct from v then raise exception 'mf_job_begin: the spec does not carry version %', v; end if;
    insert into public.mf_methodologies (version, sha256, spec, frozen_at) values (v, d, m -> 'spec', nullif(m ->> 'frozen_at', '')::date);
  elsif have <> d then
    raise exception 'mf_job_begin: methodology % was frozen with digest %, not % — a changed methodology is a new version', v, have, d;
  end if;
  perform pg_advisory_xact_lock(hashtext('mf_job_begin'));
  update public.mf_runs set status = 'failed', finished_at = now(), error = 'lease expired (no finish within 2 hours)'
   where status = 'running' and started_at < now() - interval '2 hours';
  select run_id into busy from public.mf_runs where status = 'running' order by started_at desc limit 1;
  if busy is not null then return jsonb_build_object('busy', true, 'run_id', busy); end if;
  insert into public.mf_runs (methodology_version, trigger, engine) values (v, coalesce(p ->> 'trigger', 'cron'), p ->> 'engine') returning run_id into rid;
  return jsonb_build_object('busy', false, 'run_id', rid, 'mode', public.mf_mode(), 'methodology', v);
end $$;

create or replace function public.mf_job_require_run(p_run uuid)
returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v text;
begin
  select methodology_version into v from public.mf_runs where run_id = p_run and status = 'running';
  if v is null then raise exception 'mf: run % is not running', p_run; end if;
  return v;
end $$;

create or replace function public.mf_job_known(p_version text)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'games', coalesce((select jsonb_object_agg(sport || '|' || event_id, input_hash) from public.mf_games where methodology_version = p_version), '{}'::jsonb),
    'units', coalesce((select jsonb_object_agg(unit_key, input_hash) from public.mf_units where methodology_version = p_version), '{}'::jsonb));
$$;

create or replace function public.mf_job_verifications()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'series_ticker', series_ticker, 'sport', sport, 'rules_sha256', rules_sha256,
           'overtime', overtime, 'tie', tie, 'verified', true, 'verified_at', verified_at) order by id), '[]'::jsonb)
    from public.mf_settlement_verifications;
$$;

create or replace function public.mf_job_put_games(p_run uuid, p_rows jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v text := public.mf_job_require_run(p_run); r jsonb; cur text; ins int := 0; upd int := 0; same int := 0;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then raise exception 'mf_job_put_games: an array of at most 500 rows'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    if (r -> 'payload' ->> 'methodology') is distinct from v then raise exception 'mf_job_put_games: % is not this run''s methodology %', r -> 'payload' ->> 'methodology', v; end if;
    if coalesce(r ->> 'event_id', '') ~ '^SYN_' then raise exception 'mf_job_put_games: the fixture namespace (SYN_) is never stored'; end if;
    if (r -> 'payload' ->> 'event_id') is distinct from (r ->> 'event_id') or (r -> 'payload' ->> 'sport') is distinct from (r ->> 'sport') then raise exception 'mf_job_put_games: the row and its payload disagree (%)', r ->> 'event_id'; end if;
    select input_hash into cur from public.mf_games where methodology_version = v and sport = r ->> 'sport' and event_id = r ->> 'event_id';
    if cur is not null and cur = r ->> 'input_hash' then
      update public.mf_games set last_run = p_run where methodology_version = v and sport = r ->> 'sport' and event_id = r ->> 'event_id';
      same := same + 1;
      continue;
    end if;
    insert into public.mf_game_versions (methodology_version, sport, event_id, input_hash, payload, run_id)
    values (v, r ->> 'sport', r ->> 'event_id', r ->> 'input_hash', r -> 'payload', p_run)
    on conflict (methodology_version, sport, event_id, input_hash) do nothing;
    insert into public.mf_games as g (methodology_version, sport, event_id, kickoff, home, away, state, has_kalshi, n_units, n_measured, input_hash, payload, first_run, last_run, computed_at)
    values (v, r ->> 'sport', r ->> 'event_id', (r ->> 'kickoff')::timestamptz, r ->> 'home', r ->> 'away', r ->> 'state', coalesce((r ->> 'has_kalshi')::boolean, false),
            coalesce((r ->> 'n_units')::int, 0), coalesce((r ->> 'n_measured')::int, 0), r ->> 'input_hash', r -> 'payload', p_run, p_run, now())
    on conflict (methodology_version, sport, event_id) do update set kickoff = excluded.kickoff, home = excluded.home, away = excluded.away, state = excluded.state,
      has_kalshi = excluded.has_kalshi, n_units = excluded.n_units, n_measured = excluded.n_measured, input_hash = excluded.input_hash, payload = excluded.payload,
      last_run = p_run, computed_at = now();
    if cur is null then ins := ins + 1; else upd := upd + 1; end if;
  end loop;
  return jsonb_build_object('inserted', ins, 'updated', upd, 'unchanged', same);
end $$;

create or replace function public.mf_job_put_units(p_run uuid, p_rows jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v text := public.mf_job_require_run(p_run); r jsonb; cur text; ins int := 0; upd int := 0; same int := 0;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then raise exception 'mf_job_put_units: an array of at most 500 rows'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    if (r -> 'payload' ->> 'methodology') is distinct from v then raise exception 'mf_job_put_units: % is not this run''s methodology %', r -> 'payload' ->> 'methodology', v; end if;
    -- checked before the unchanged shortcut, so no row slips past them on a reused hash
    if coalesce(r ->> 'event_id', '') ~ '^SYN_' or coalesce(r ->> 'model_key', '') ~ '^syn_' then raise exception 'mf_job_put_units: the fixture namespace (SYN_ / syn_) is never stored'; end if;
    if ((r ->> 'status') = 'excluded') is distinct from (nullif(r ->> 'exclusion_reason', '') is not null) then raise exception 'mf_job_put_units: an excluded unit names its reason, a measured one has none (%)', r ->> 'unit_key'; end if;
    if (r -> 'payload' ->> 'unit_key') is distinct from (r ->> 'unit_key') or (r -> 'payload' ->> 'event_id') is distinct from (r ->> 'event_id') then raise exception 'mf_job_put_units: the row and its payload disagree (%)', r ->> 'unit_key'; end if;
    select input_hash into cur from public.mf_units where methodology_version = v and unit_key = r ->> 'unit_key';
    if cur is not null and cur = r ->> 'input_hash' then
      update public.mf_units set last_run = p_run where methodology_version = v and unit_key = r ->> 'unit_key';
      same := same + 1;
      continue;
    end if;
    insert into public.mf_unit_versions (methodology_version, unit_key, input_hash, payload, run_id)
    values (v, r ->> 'unit_key', r ->> 'input_hash', r -> 'payload', p_run)
    on conflict (methodology_version, unit_key, input_hash) do nothing;
    insert into public.mf_units as u (methodology_version, unit_key, sport, event_id, kickoff, source, model_key, model_label, model_version, creator, market, measure, venue,
                                      status, exclusion_reason, cls, precedence, horizon_bucket, published_at, input_hash, payload, first_run, last_run, updated_at)
    values (v, r ->> 'unit_key', r ->> 'sport', r ->> 'event_id', (r ->> 'kickoff')::timestamptz, r ->> 'source', r ->> 'model_key', r ->> 'model_label', r ->> 'model_version',
            r ->> 'creator', r ->> 'market', r ->> 'measure', r ->> 'venue', r ->> 'status', nullif(r ->> 'exclusion_reason', ''), r ->> 'cls', r ->> 'precedence',
            r ->> 'horizon_bucket', (r ->> 'published_at')::timestamptz, r ->> 'input_hash', r -> 'payload', p_run, p_run, now())
    on conflict (methodology_version, unit_key) do update set kickoff = excluded.kickoff, model_label = excluded.model_label, creator = excluded.creator,
      status = excluded.status, exclusion_reason = excluded.exclusion_reason, cls = excluded.cls, precedence = excluded.precedence,
      horizon_bucket = excluded.horizon_bucket, published_at = excluded.published_at, input_hash = excluded.input_hash, payload = excluded.payload,
      last_run = p_run, updated_at = now();
    if cur is null then ins := ins + 1; else upd := upd + 1; end if;
  end loop;
  return jsonb_build_object('inserted', ins, 'updated', upd, 'unchanged', same);
end $$;

-- the run's summaries are the complete set: rows of this methodology the run
-- did not produce are removed (they are re-derivable from the units)
create or replace function public.mf_job_put_summaries(p_run uuid, p_rows jsonb, p_final boolean default true)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v text := public.mf_job_require_run(p_run); r jsonb; n int := 0; gone int := 0;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 2000 then raise exception 'mf_job_put_summaries: an array of at most 2000 rows'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    insert into public.mf_summaries (methodology_version, window_key, key, source, model_key, model_label, model_version, sport, market, venue, horizon_bucket, evidence, payload, run_id)
    values (v, r ->> 'window', r ->> 'key', r ->> 'source', r ->> 'model_key', r ->> 'model_label', r ->> 'model_version', r ->> 'sport', r ->> 'market', r ->> 'venue',
            r ->> 'horizon_bucket', r ->> 'evidence', r -> 'payload', p_run)
    on conflict (methodology_version, window_key, key) do update set model_label = excluded.model_label, evidence = excluded.evidence, payload = excluded.payload, run_id = p_run;
    n := n + 1;
  end loop;
  if p_final then
    delete from public.mf_summaries where methodology_version = v and run_id <> p_run;
    get diagnostics gone = row_count;
  end if;
  return jsonb_build_object('upserted', n, 'removed', gone);
end $$;

create or replace function public.mf_job_finish(p_run uuid, p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare st text := coalesce(p ->> 'status', 'ok'); lg jsonb := coalesce(p -> 'log', '[]'::jsonb);
begin
  perform public.mf_job_require_run(p_run);
  if st not in ('ok', 'partial', 'failed') then raise exception 'mf_job_finish: status % is not ok, partial or failed', st; end if;
  if jsonb_typeof(lg) = 'array' and jsonb_array_length(lg) > 500 then
    lg := (select jsonb_agg(x) from (select x from jsonb_array_elements(lg) with ordinality t (x, i) where i <= 500) s)
          || jsonb_build_array(jsonb_build_object('level', 'note', 'code', 'log_truncated', 'message', 'only the first 500 log entries are kept'));
  end if;
  update public.mf_runs set status = st, finished_at = now(), sources = coalesce(p -> 'sources', '{}'::jsonb), counts = coalesce(p -> 'counts', '{}'::jsonb),
    log = lg, coverage = coalesce(p -> 'coverage', '[]'::jsonb), lead_lag = coalesce(p -> 'lead_lag', '[]'::jsonb),
    incremental = coalesce(p -> 'incremental', '[]'::jsonb), error = p ->> 'error'
   where run_id = p_run;
  return jsonb_build_object('run_id', p_run, 'status', st);
end $$;

-- ---------------------------------------------------------------- the readers' doors
-- anyone: the mode, the methodology, the latest run's coverage and freshness.
-- No forecast and no price is in it.
create or replace function public.mf_status()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare rd jsonb := public.mf_reader(); v text := public.mf_current_version(); r public.mf_runs; mth public.mf_methodologies;
begin
  if rd ->> 'mode' = 'off' and not (rd ->> 'admin')::boolean then return jsonb_build_object('mode', 'off'); end if;
  select * into r from public.mf_runs where status in ('ok', 'partial') order by started_at desc limit 1;
  select * into mth from public.mf_methodologies where version = v;
  return jsonb_build_object(
    'mode', rd ->> 'mode', 'reader', rd,
    'methodology', case when mth.version is null then null else jsonb_build_object('version', mth.version, 'sha256', mth.sha256, 'frozen_at', mth.frozen_at) end,
    'last_run', case when r.run_id is null then null else jsonb_build_object('run_id', r.run_id, 'status', r.status, 'started_at', r.started_at, 'finished_at', r.finished_at,
                  'counts', r.counts, 'sources', r.sources) end,
    'coverage', coalesce(r.coverage, '[]'::jsonb),
    'public_timeline', coalesce((public.mf_cfg('public_timeline'))::text = 'true', false));
end $$;

-- live (or an operator): every summary of publishable models, filtered
create or replace function public.mf_overview(p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare rd jsonb := public.mf_reader(); f jsonb := coalesce(p_filters, '{}'::jsonb); v text := public.mf_current_version(); r public.mf_runs; rows jsonb;
        lim int := least(greatest(coalesce((f ->> 'limit')::int, 300), 1), 1000);
begin
  if not (rd ->> 'can_read')::boolean then return jsonb_build_object('mode', rd ->> 'mode', 'locked', true); end if;
  if coalesce(f ->> 'window', 'all') not in ('all', '30d', '7d') then raise exception 'mf_overview: window must be all, 30d or 7d'; end if;
  select coalesce(jsonb_agg(s.payload || jsonb_build_object('window', s.window_key) order by s.source, s.model_label, s.model_version, s.sport, s.market, s.venue, s.horizon_bucket), '[]'::jsonb) into rows
    from (select * from public.mf_summaries s
           where s.methodology_version = v
             and s.window_key = coalesce(f ->> 'window', 'all')
             and s.horizon_bucket = coalesce(f ->> 'bucket', 'all')
             and (f ->> 'sport' is null or s.sport = f ->> 'sport')
             and (f ->> 'market' is null or s.market = f ->> 'market')
             and (f ->> 'venue' is null or s.venue = f ->> 'venue')
             and (f ->> 'source' is null or s.source = f ->> 'source')
             and (f ->> 'model_key' is null or s.model_key = f ->> 'model_key')
             and ((rd ->> 'admin')::boolean or public.mf_visible(s.source, s.model_key))
           order by s.source, s.model_label, s.model_version, s.sport, s.market, s.venue
           limit lim) s;
  select * into r from public.mf_runs where status in ('ok', 'partial') and methodology_version = v order by started_at desc limit 1;
  return jsonb_build_object('mode', rd ->> 'mode', 'methodology', v, 'run_id', r.run_id, 'finished_at', r.finished_at, 'summaries', rows,
    'lead_lag', coalesce(r.lead_lag, '[]'::jsonb), 'incremental', coalesce(r.incremental, '[]'::jsonb), 'counts', coalesce(r.counts, '{}'::jsonb),
    'coverage', coalesce(r.coverage, '[]'::jsonb), 'sources', coalesce(r.sources, '{}'::jsonb), 'reader', rd);
end $$;

create or replace function public.mf_games_list(p_filters jsonb default '{}'::jsonb, p_cursor text default null, p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare rd jsonb := public.mf_reader(); f jsonb := coalesce(p_filters, '{}'::jsonb); v text := public.mf_current_version();
        c jsonb := public.mf_cursor_in(p_cursor); lim int := least(greatest(coalesce(p_limit, 50), 1), 100); items jsonb; last jsonb; n int;
begin
  if not (rd ->> 'can_read')::boolean then return jsonb_build_object('mode', rd ->> 'mode', 'locked', true); end if;
  with page as (
    select g.sport, g.event_id, g.kickoff, g.home, g.away, g.state, g.has_kalshi, g.n_units, g.n_measured
      from public.mf_games g
     where g.methodology_version = v
       and (f ->> 'sport' is null or g.sport = f ->> 'sport')
       and (f ->> 'from' is null or g.kickoff >= (f ->> 'from')::timestamptz)
       and (f ->> 'to' is null or g.kickoff < (f ->> 'to')::timestamptz)
       and (f ->> 'model_key' is null or exists (select 1 from public.mf_units u where u.methodology_version = v and u.sport = g.sport and u.event_id = g.event_id and u.model_key = f ->> 'model_key'))
       and (c is null or (g.kickoff, g.sport || '|' || g.event_id) < ((c ->> 'k')::timestamptz, c ->> 'id'))
     order by g.kickoff desc, g.sport || '|' || g.event_id desc
     limit lim + 1)
  select coalesce(jsonb_agg(to_jsonb(p) order by p.kickoff desc, p.sport || '|' || p.event_id desc), '[]'::jsonb), count(*) into items, n from page p;
  if n > lim then
    items := (select jsonb_agg(x) from (select x from jsonb_array_elements(items) with ordinality t (x, i) where i <= lim) s);
    last := items -> (lim - 1);
    return jsonb_build_object('items', items, 'next', public.mf_cursor_out(jsonb_build_object('k', last ->> 'kickoff', 'id', (last ->> 'sport') || '|' || (last ->> 'event_id'))));
  end if;
  return jsonb_build_object('items', items, 'next', null);
end $$;

create or replace function public.mf_game(p_sport text, p_event_id text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare rd jsonb := public.mf_reader(); v text := public.mf_current_version(); g public.mf_games; units jsonb; adm boolean;
begin
  if not (rd ->> 'can_read')::boolean then return jsonb_build_object('mode', rd ->> 'mode', 'locked', true); end if;
  adm := (rd ->> 'admin')::boolean;
  select * into g from public.mf_games where methodology_version = v and sport = p_sport and event_id = p_event_id;
  if g.event_id is null then return jsonb_build_object('found', false); end if;
  select coalesce(jsonb_agg(public.mf_unit_out(u, adm) order by u.source, u.model_label, u.model_version, u.market, u.venue), '[]'::jsonb) into units
    from public.mf_units u where u.methodology_version = v and u.sport = p_sport and u.event_id = p_event_id and (adm or public.mf_visible(u.source, u.model_key));
  return jsonb_build_object('found', true, 'methodology', v, 'full_access', (rd ->> 'full_access')::boolean, 'reader', rd,
    'game', public.mf_game_out(g.payload, (rd ->> 'full_access')::boolean, adm), 'units', units, 'computed_at', g.computed_at);
end $$;

-- one model's complete record: every unit, measured or not, newest first
create or replace function public.mf_model(p_filters jsonb, p_cursor text default null, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare rd jsonb := public.mf_reader(); f jsonb := coalesce(p_filters, '{}'::jsonb); v text := public.mf_current_version(); c jsonb := public.mf_cursor_in(p_cursor);
        lim int := least(greatest(coalesce(p_limit, 100), 1), 200); src text := f ->> 'source'; mk text := f ->> 'model_key'; adm boolean;
        items jsonb; n int; last jsonb; sums jsonb; versions jsonb; label text; counts jsonb;
begin
  if not (rd ->> 'can_read')::boolean then return jsonb_build_object('mode', rd ->> 'mode', 'locked', true); end if;
  adm := (rd ->> 'admin')::boolean;
  if src is null or mk is null then raise exception 'mf_model: source and model_key are required'; end if;
  if not adm and not public.mf_visible(src, mk) then return jsonb_build_object('found', false); end if;
  select max(model_label), coalesce(jsonb_agg(distinct model_version), '[]'::jsonb),
         jsonb_build_object('units', count(*), 'measured', count(*) filter (where status = 'measured'), 'excluded', count(*) filter (where status = 'excluded'))
    into label, versions, counts
    from public.mf_units where methodology_version = v and source = src and model_key = mk and (f ->> 'model_version' is null or model_version = f ->> 'model_version');
  if label is null then return jsonb_build_object('found', false); end if;
  select coalesce(jsonb_agg(s.payload || jsonb_build_object('window', s.window_key) order by s.model_version, s.sport, s.market, s.venue, s.horizon_bucket), '[]'::jsonb) into sums
    from public.mf_summaries s where s.methodology_version = v and s.source = src and s.model_key = mk and s.window_key = 'all'
     and (f ->> 'model_version' is null or s.model_version = f ->> 'model_version');
  with page as (
    select u.* from public.mf_units u
     where u.methodology_version = v and u.source = src and u.model_key = mk
       and (f ->> 'model_version' is null or u.model_version = f ->> 'model_version')
       and (f ->> 'sport' is null or u.sport = f ->> 'sport')
       and (f ->> 'market' is null or u.market = f ->> 'market')
       and (c is null or (u.kickoff, u.unit_key) < ((c ->> 'k')::timestamptz, c ->> 'id'))
     order by u.kickoff desc, u.unit_key desc
     limit lim + 1)
  select coalesce(jsonb_agg(public.mf_unit_out(p, adm) order by p.kickoff desc, p.unit_key desc), '[]'::jsonb), count(*) into items, n from page p;
  last := null;
  if n > lim then
    items := (select jsonb_agg(x) from (select x from jsonb_array_elements(items) with ordinality t (x, i) where i <= lim) s);
    last := items -> (lim - 1);
  end if;
  return jsonb_build_object('found', true, 'methodology', v, 'source', src, 'model_key', mk, 'model_label', label, 'versions', versions, 'counts', counts,
    'summaries', sums, 'units', items, 'reader', rd,
    'next', case when last is null then null else public.mf_cursor_out(jsonb_build_object('k', last ->> 'kickoff', 'id', last ->> 'unit_key')) end);
end $$;

-- the embed: a model's top line per sport, market and venue, with its sample
create or replace function public.mf_embed(p_source text, p_model_key text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare rd jsonb := public.mf_reader(); v text := public.mf_current_version(); rows jsonb; label text;
begin
  if (rd ->> 'mode') <> 'live' then return jsonb_build_object('found', false, 'mode', rd ->> 'mode'); end if;
  if not public.mf_visible(p_source, p_model_key) then return jsonb_build_object('found', false); end if;
  select max(model_label), coalesce(jsonb_agg(jsonb_build_object('model_version', model_version, 'sport', sport, 'market', market, 'venue', venue, 'evidence', evidence,
           'measured', payload -> 'measured', 'material', payload -> 'material', 'closer', payload -> 'closer', 'qualifying', payload -> 'qualifying',
           'precedence', payload -> 'precedence', 'convergence_median', payload -> 'convergence' -> 'median', 'convergence_n', payload -> 'convergence' -> 'n')
           order by model_version, sport, market, venue), '[]'::jsonb)
    into label, rows
    from public.mf_summaries where methodology_version = v and window_key = 'all' and horizon_bucket = 'all' and source = p_source and model_key = p_model_key;
  if label is null then return jsonb_build_object('found', false); end if;
  return jsonb_build_object('found', true, 'methodology', v, 'source', p_source, 'model_key', p_model_key, 'model_label', label, 'rows', rows);
end $$;

-- ---------------------------------------------------------------- operators
create or replace function public.mf_require_admin()
returns uuid language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.mf_is_admin() then raise exception 'mf: operators only' using errcode = '42501'; end if;
  return auth.uid();
end $$;

create or replace function public.mf_set_cfg(p_key text, p_value jsonb, p_actor uuid, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare old jsonb;
begin
  select value into old from public.mf_config where key = p_key;
  insert into public.mf_config (key, value, updated_at, updated_by) values (p_key, p_value, now(), p_actor)
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = p_actor;
  insert into public.mf_config_log (key, old_value, new_value, changed_by, reason) values (p_key, old, p_value, p_actor, p_reason);
  return jsonb_build_object('key', p_key, 'value', p_value, 'previous', old);
end $$;

create or replace function public.mf_admin_set_mode(p_mode text, p_reason text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare actor uuid := public.mf_require_admin();
begin
  if p_mode not in ('off', 'shadow', 'live') then raise exception 'mf: mode must be off, shadow or live'; end if;
  return public.mf_set_cfg('mode', to_jsonb(p_mode), actor, p_reason);
end $$;

create or replace function public.mf_admin_set_public_timeline(p_on boolean, p_reason text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare actor uuid := public.mf_require_admin();
begin
  return public.mf_set_cfg('public_timeline', to_jsonb(coalesce(p_on, false)), actor, p_reason);
end $$;

-- the owner's switch: the SQL editor or the mode workflow (no API role)
create or replace function public.mf_owner_set_mode(p_mode text, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if p_mode not in ('off', 'shadow', 'live') then raise exception 'mf: mode must be off, shadow or live'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'mf_owner_set_mode: say why'; end if;
  return public.mf_set_cfg('mode', to_jsonb(p_mode), null, p_reason);
end $$;

create or replace function public.mf_admin_runs(p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare actor uuid := public.mf_require_admin();
begin
  return coalesce((select jsonb_agg(to_jsonb(r) order by r.started_at desc) from (select * from public.mf_runs order by started_at desc limit least(greatest(coalesce(p_limit, 20), 1), 100)) r), '[]'::jsonb);
end $$;

-- the rules texts of the linked Kalshi markets, each with its digest and
-- whether a verification covers it: what an operator reads before verifying
create or replace function public.mf_admin_pending_rules()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare actor uuid := public.mf_require_admin(); out jsonb;
begin
  if to_regclass('public.kalshi_markets') is null or to_regclass('public.kalshi_game_links') is null then
    return jsonb_build_object('installed', false, 'rules', '[]'::jsonb);
  end if;
  execute $q$
    select coalesce(jsonb_agg(x order by x->>'series_ticker', x->>'rules_sha256'), '[]'::jsonb) from (
      select jsonb_build_object('series_ticker', m.series_ticker, 'sport', l.sport,
               'rules_sha256', encode(sha256(convert_to(m.rules_primary, 'UTF8')), 'hex'), 'rules_primary', m.rules_primary,
               'markets', count(*), 'latest_kickoff', max(l.kickoff_at),
               'verified', exists (select 1 from public.mf_settlement_verifications v where v.series_ticker = m.series_ticker
                                    and v.rules_sha256 = encode(sha256(convert_to(m.rules_primary, 'UTF8')), 'hex'))) as x
        from public.kalshi_game_links l join public.kalshi_markets m on m.ticker = l.market_ticker
       where m.rules_primary is not null
       group by m.series_ticker, l.sport, m.rules_primary) s $q$ into out;
  return jsonb_build_object('installed', true, 'rules', out);
end $$;

create or replace function public.mf_admin_verify_settlement(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare actor uuid := public.mf_require_admin(); id bigint;
begin
  insert into public.mf_settlement_verifications (series_ticker, sport, rules_sha256, overtime, tie, cancellation, rules_excerpt, note, verified_by)
  values (p ->> 'series_ticker', p ->> 'sport', p ->> 'rules_sha256', p ->> 'overtime', p ->> 'tie', p ->> 'cancellation', p ->> 'rules_excerpt', p ->> 'note', actor)
  returning mf_settlement_verifications.id into id;
  return jsonb_build_object('id', id, 'verified_by', actor);
end $$;

-- ---------------------------------------------------------------- row level security
do $rls$
declare t text;
begin
  foreach t in array array['mf_config', 'mf_config_log', 'mf_methodologies', 'mf_runs', 'mf_games', 'mf_game_versions', 'mf_units', 'mf_unit_versions',
                           'mf_summaries', 'mf_settlement_verifications'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke insert, update, delete, truncate on public.%I from service_role', t);
      execute format('grant select on public.%I to service_role', t);
    end if;
  end loop;
end $rls$;

-- ---------------------------------------------------------------- function grants
do $g$
declare f text;
begin
  -- the job's doors and internals: service_role only
  foreach f in array array['public.mf_job_begin(jsonb)', 'public.mf_job_require_run(uuid)', 'public.mf_job_known(text)', 'public.mf_job_verifications()',
    'public.mf_job_put_games(uuid,jsonb)', 'public.mf_job_put_units(uuid,jsonb)', 'public.mf_job_put_summaries(uuid,jsonb,boolean)', 'public.mf_job_finish(uuid,jsonb)',
    'public.mf_keep()', 'public.mf_runs_guard()'] loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    if exists (select 1 from pg_roles where rolname = 'service_role') and f !~ '(keep|guard)\(\)$' then execute 'grant execute on function ' || f || ' to service_role'; end if;
  end loop;
  -- anyone: the status and, when live, the derived measurements
  foreach f in array array['public.mf_status()', 'public.mf_overview(jsonb)', 'public.mf_games_list(jsonb,text,integer)', 'public.mf_game(text,text)',
    'public.mf_model(jsonb,text,integer)', 'public.mf_embed(text,text)', 'public.mf_viewer_entitled()', 'public.mf_is_admin()'] loop
    execute 'revoke all on function ' || f || ' from public';
    execute 'grant execute on function ' || f || ' to anon, authenticated';
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function ' || f || ' to service_role'; end if;
  end loop;
  -- operators (a signed-in account; each door checks mf_is_admin)
  foreach f in array array['public.mf_admin_set_mode(text,text)', 'public.mf_admin_set_public_timeline(boolean,text)', 'public.mf_admin_runs(integer)',
    'public.mf_admin_pending_rules()', 'public.mf_admin_verify_settlement(jsonb)', 'public.mf_require_admin()'] loop
    execute 'revoke all on function ' || f || ' from public, anon';
    execute 'grant execute on function ' || f || ' to authenticated';
  end loop;
  -- internals no API role calls directly (the doors run as the owner)
  foreach f in array array['public.mf_owner_set_mode(text,text)', 'public.mf_set_cfg(text,jsonb,uuid,text)', 'public.mf_cfg(text)', 'public.mf_mode()', 'public.mf_reader()',
    'public.mf_collective_visible(text)', 'public.mf_visible(text,text)', 'public.mf_strip_members(jsonb)', 'public.mf_unit_out(public.mf_units,boolean)',
    'public.mf_game_out(jsonb,boolean,boolean)', 'public.mf_current_version()', 'public.mf_cursor_in(text)', 'public.mf_cursor_out(jsonb)'] loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'revoke all on function ' || f || ' from service_role'; end if;
  end loop;
end $g$;
grant execute on function public.mf_status() to anon, authenticated;
grant execute on function public.mf_overview(jsonb) to anon, authenticated;
grant execute on function public.mf_games_list(jsonb,text,integer) to anon, authenticated;
grant execute on function public.mf_game(text,text) to anon, authenticated;
grant execute on function public.mf_model(jsonb,text,integer) to anon, authenticated;
grant execute on function public.mf_embed(text,text) to anon, authenticated;

commit;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------- report
select 1 as row, 'tables exist' as check,
       case when to_regclass('public.mf_units') is not null and to_regclass('public.mf_games') is not null and to_regclass('public.mf_runs') is not null
             and to_regclass('public.mf_methodologies') is not null and to_regclass('public.mf_settlement_verifications') is not null then 'ok' else 'CHECK THIS' end as result
union all select 2, 'row level security on every mf table',
       case when (select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'mf\_%') then 'ok' else 'CHECK THIS' end
union all select 3, 'no client role can read or write an mf table directly',
       case when not exists (select 1 from information_schema.role_table_grants g where g.table_schema = 'public' and g.table_name like 'mf\_%' and g.grantee in ('anon', 'authenticated')) then 'ok' else 'CHECK THIS' end
union all select 4, 'the job doors are not callable by clients',
       case when not has_function_privilege('anon', 'public.mf_job_put_units(uuid,jsonb)', 'execute') and not has_function_privilege('authenticated', 'public.mf_job_put_units(uuid,jsonb)', 'execute')
             and not has_function_privilege('authenticated', 'public.mf_job_begin(jsonb)', 'execute') then 'ok' else 'CHECK THIS' end
union all select 5, 'history tables refuse update and delete',
       case when (select count(*) from pg_trigger where tgname in ('mf_config_log_frozen', 'mf_methodologies_frozen', 'mf_game_versions_frozen', 'mf_unit_versions_frozen', 'mf_settlement_verifications_frozen')) = 5 then 'ok' else 'CHECK THIS' end
union all select 6, 'the entitlement gate defers to the project rule',
       case when to_regprocedure('public.community_is_entitled(uuid)') is not null then 'ok' else 'CHECK THIS: public.community_is_entitled(uuid) is not installed — nobody gets Full Access timelines (fail closed) until it is' end
union all select 7, 'an anonymous caller is neither entitled nor an operator',
       case when not public.mf_viewer_entitled() and not public.mf_is_admin() then 'ok' else 'CHECK THIS' end
union all select 8, 'mode',
       case public.mf_mode() when 'shadow' then 'ok: shadow (stored and reviewable by operators; nothing is published until live)'
                             when 'live' then 'ok: live' when 'off' then 'ok: off (every reader door answers mode off)' else 'CHECK THIS' end
union all select 9, 'the owner''s mode door is reachable by no API role',
       case when not has_function_privilege('anon', 'public.mf_owner_set_mode(text,text)', 'execute') and not has_function_privilege('authenticated', 'public.mf_owner_set_mode(text,text)', 'execute')
             and (not exists (select 1 from pg_roles where rolname = 'service_role') or not has_function_privilege('service_role', 'public.mf_owner_set_mode(text,text)', 'execute')) then 'ok' else 'CHECK THIS' end
union all select 10, 'Kalshi settlement verifications',
       case when exists (select 1 from public.mf_settlement_verifications) then 'ok: ' || (select count(*) from public.mf_settlement_verifications) || ' recorded'
            else 'pending: no Kalshi series is verified, so Kalshi is shown and never compared (mf_admin_pending_rules lists what to read)' end
union all select 11, 'Collective visibility check',
       case when to_regclass('collective.models') is not null and to_regclass('collective.creators') is not null then 'ok'
            else 'pending: collective.models / creators are not installed here — every Collective unit stays hidden (fail closed)' end;
