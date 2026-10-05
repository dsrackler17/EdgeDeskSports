-- portfolio_decision -- part 5 of 9.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

create table if not exists public.portfolio_insights (
  id                   uuid        primary key default gen_random_uuid(),
  user_id              uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  dim                  text        not null,
  key                  text        not null,
  metric               text        not null,
  kind                 text        not null,
  label                text        not null,
  methodology_version  text        not null,
  first_detected_at    timestamptz not null default now(),
  constraint portfolio_insights_shape check (metric in ('clv', 'ps', 'ret') and kind in ('LEAK', 'STRENGTH')
    and dim ~ '^[a-z_]{2,30}$' and length(key) between 1 and 120 and length(label) between 1 and 200)
);
comment on table public.portfolio_insights is
  'PROCESS MEMORY. A pattern in the reader''s own history (a group on a metric), when it was first detected and under which methodology. Its observations carry the numbers and the positions behind them.';
create unique index if not exists portfolio_insights_once on public.portfolio_insights (user_id, dim, key, metric, methodology_version);

create table if not exists public.portfolio_insight_observations (
  id                   bigint      generated always as identity primary key,
  insight_id           uuid        not null references public.portfolio_insights(id) on delete cascade,
  user_id              uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  observed_at          timestamptz not null default now(),
  methodology_version  text        not null,
  tz                   text        not null,
  window_from          timestamptz null,
  window_to            timestamptz null,
  grp                  jsonb       not null,
  comparison           jsonb       not null,
  since_first          jsonb       not null,
  before_first         jsonb       not null,
  confidence           text        not null,
  position_ids         uuid[]      not null,
  position_count       int         not null,
  excluded             jsonb       not null default '{}'::jsonb
);
comment on table public.portfolio_insight_observations is
  'APPEND-ONLY. One look at a pattern: the group and comparison moments, the same group split at first detection, the exact positions used (lineage) and those excluded with the reason. Computed by portfolio_observe_insight().';
create index if not exists portfolio_insight_obs on public.portfolio_insight_observations (insight_id, observed_at desc);

create or replace function public.portfolio_insight_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and tg_table_name = 'portfolio_insight_observations' then
    raise exception 'portfolio: an observation is never rewritten' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then
    /* a pattern's identity and first detection are fixed */
    new.id := old.id; new.user_id := old.user_id; new.dim := old.dim; new.key := old.key; new.metric := old.metric; new.kind := old.kind;
    new.methodology_version := old.methodology_version; new.first_detected_at := old.first_detected_at;
    return new;
  end if;
  if not public.portfolio_writer_is('insight') then
    raise exception 'portfolio: process memory is computed by portfolio_observe_insight(), not written' using errcode = '42501';
  end if;
  if auth.uid() is not null then new.user_id := auth.uid(); end if;
  return new;
end $$;
drop trigger if exists portfolio_insights_guard_trg on public.portfolio_insights;
create trigger portfolio_insights_guard_trg before insert or update on public.portfolio_insights
  for each row execute function public.portfolio_insight_guard();
drop trigger if exists portfolio_insight_obs_guard_trg on public.portfolio_insight_observations;
create trigger portfolio_insight_obs_guard_trg before insert or update on public.portfolio_insight_observations
  for each row execute function public.portfolio_insight_guard();

-- record one look at a pattern the Process page surfaced. The page names the
-- group and the window; every number and every position is computed here.
-- A look whose numbers have not changed within 12 hours is not stored twice.
create or replace function public.portfolio_observe_insight(p_dim text, p_key text, p_metric text, p_kind text, p_label text,
    p_from timestamptz, p_to timestamptz, p_tz text default null)
returns jsonb language plpgsql volatile set jit = off as $$
declare z text := public.portfolio_facts_fresh(p_tz); mv text := public.portfolio_methodology_current('INSIGHT_TEST');
  ins record; g jsonb; cmp jsonb; sf jsonb; bf jsonb; ids uuid[]; excl jsonb; last record; col text;
begin
  if auth.uid() is null then raise exception 'portfolio: sign in first' using errcode = '42501'; end if;
  if p_metric not in ('clv', 'ps', 'ret') or p_kind not in ('LEAK', 'STRENGTH') or p_dim !~ '^[a-z_]{2,30}$' or coalesce(length(p_key), 0) not between 1 and 120 then
    raise exception 'portfolio: not a pattern this methodology tests' using errcode = '22023';
  end if;
  perform set_config('portfolio.writer', 'insight', true);
  insert into public.portfolio_insights (user_id, dim, key, metric, kind, label, methodology_version)
  values (auth.uid(), p_dim, p_key, p_metric, p_kind, left(coalesce(nullif(btrim(p_label), ''), p_dim || ': ' || p_key), 200), mv)
  on conflict (user_id, dim, key, metric, methodology_version) do nothing;
  select * into ins from public.portfolio_insights i where i.user_id = auth.uid() and i.dim = p_dim and i.key = p_key and i.metric = p_metric
     and i.methodology_version = mv;
  col := case p_metric when 'clv' then 'clv_pct' when 'ps' then 'process_score' else 'ret' end;
  execute format($q$
    with f as (select c.*, c.%1$I as v, public.portfolio_fact_in($1, $2, c) as in_grp from public.portfolio_facts_cache c
                where c.user_id = auth.uid() and c.tz = $3 and ($4::timestamptz is null or c.placed_at >= $4) and ($5::timestamptz is null or c.placed_at < $5))
    select jsonb_build_array(count(v) filter (where in_grp), coalesce(sum(v) filter (where in_grp), 0), coalesce(sum(v * v) filter (where in_grp), 0)),
           jsonb_build_array(count(v) filter (where not in_grp), coalesce(sum(v) filter (where not in_grp), 0), coalesce(sum(v * v) filter (where not in_grp), 0)),
           jsonb_build_array(count(v) filter (where in_grp and placed_at >= $6), coalesce(sum(v) filter (where in_grp and placed_at >= $6), 0),
                             coalesce(sum(v * v) filter (where in_grp and placed_at >= $6), 0)),
           jsonb_build_array(count(v) filter (where in_grp and placed_at < $6), coalesce(sum(v) filter (where in_grp and placed_at < $6), 0),
                             coalesce(sum(v * v) filter (where in_grp and placed_at < $6), 0)),
           (select array_agg(id order by placed_at, id) from (select id, placed_at from f where in_grp and v is not null order by placed_at, id limit 1000) q),
           jsonb_strip_nulls(jsonb_build_object(
             'NO_CLOSING_PRICE', nullif(count(*) filter (where in_grp and v is null and $7 = 'clv' and clv_points is null), 0),
             'LINE_MOVED_CLV_IN_POINTS', nullif(count(*) filter (where in_grp and v is null and $7 = 'clv' and clv_points is not null), 0),
             'NOT_GRADED', nullif(count(*) filter (where in_grp and v is null and $7 = 'ps'), 0),
             'NOT_SETTLED', nullif(count(*) filter (where in_grp and v is null and $7 = 'ret' and status = 'OPEN'), 0),
             'NO_RETURN', nullif(count(*) filter (where in_grp and v is null and $7 = 'ret' and status <> 'OPEN'), 0)))
      from f $q$, col)
    into g, cmp, sf, bf, ids, excl using p_dim, p_key, z, p_from, p_to, ins.first_detected_at, p_metric;
  select * into last from public.portfolio_insight_observations o where o.insight_id = ins.id order by o.observed_at desc limit 1;
  if last.id is not null and last.observed_at > now() - interval '12 hours' and last.grp = g and last.comparison = cmp
     and last.window_from is not distinct from p_from and last.window_to is not distinct from p_to then
    perform set_config('portfolio.writer', '', true);
    return jsonb_build_object('insight', to_jsonb(ins), 'observation', to_jsonb(last), 'stored', false);
  end if;
  insert into public.portfolio_insight_observations (insight_id, user_id, methodology_version, tz, window_from, window_to, grp, comparison,
      since_first, before_first, confidence, position_ids, position_count, excluded)
  values (ins.id, auth.uid(), mv, z, p_from, p_to, g, cmp, sf, bf, public.portfolio_confidence((g->>0)::bigint), coalesce(ids, array[]::uuid[]),
          (g->>0)::int, coalesce(excl, '{}'::jsonb))
  returning * into last;
  perform set_config('portfolio.writer', '', true);
  return jsonb_build_object('insight', to_jsonb(ins), 'observation', to_jsonb(last), 'stored', true);
end $$;

-- every pattern the caller has, with its first observation (THEN) and its
-- latest (NOW); the status is computed from these by the page
create or replace function public.portfolio_insight_memory()
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('insight', to_jsonb(i), 'first', to_jsonb(f), 'latest', to_jsonb(l), 'observations', k.n)
           order by l.observed_at desc), '[]'::jsonb)
    from public.portfolio_insights i
    cross join lateral (select o.* from public.portfolio_insight_observations o where o.insight_id = i.id order by o.observed_at asc limit 1) f
    cross join lateral (select o.* from public.portfolio_insight_observations o where o.insight_id = i.id order by o.observed_at desc limit 1) l
    cross join lateral (select count(*) as n from public.portfolio_insight_observations o where o.insight_id = i.id) k
   where i.user_id = auth.uid()
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. EXPERIMENTS — a permanent record: criteria and baseline frozen at the
--     start, the result and conclusion written once, the reflection once
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.portfolio_experiments add column if not exists success_criteria text null;
alter table public.portfolio_experiments add column if not exists tz text null;
alter table public.portfolio_experiments add column if not exists baseline jsonb null;
alter table public.portfolio_experiments add column if not exists result jsonb null;
alter table public.portfolio_experiments add column if not exists conclusion text null;
alter table public.portfolio_experiments add column if not exists concluded_at timestamptz null;
alter table public.portfolio_experiments add column if not exists result_methodology text null;
alter table public.portfolio_experiments add column if not exists reflection text null;
alter table public.portfolio_experiments add column if not exists reflected_at timestamptz null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'portfolio_experiments_record') then
    alter table public.portfolio_experiments add constraint portfolio_experiments_record check (
      coalesce(length(success_criteria), 0) <= 300 and coalesce(length(reflection), 0) <= 1000
      and (conclusion is null or conclusion in ('SUPPORTED', 'NOT_SUPPORTED', 'INCONCLUSIVE'))
      and (result is null or (jsonb_typeof(result) = 'object' and pg_column_size(result) <= 65536))
      and (baseline is null or jsonb_typeof(baseline) = 'object'));
  end if;
end $$;

-- the metric's moments over the positions placed in a window, the positions
-- themselves, and how many followed the experiment's condition
create or replace function public.portfolio_experiment_window(p_metric text, p_condition jsonb, p_from timestamptz, p_to timestamptz, p_tz text)
returns jsonb language sql stable as $$
  with f as (select c as r, c.id, c.placed_at, case p_metric when 'CLV' then c.clv_pct when 'PROCESS' then c.process_score else c.ret end as v
               from public.portfolio_facts_cache c
              where c.user_id = auth.uid() and c.tz = p_tz and c.placed_at >= p_from and c.placed_at < p_to)
  select jsonb_build_object('from', p_from, 'to', p_to, 'positions', count(*),
    'moments', jsonb_build_array(count(v), coalesce(sum(v), 0), coalesce(sum(v * v), 0)),
    'followed', case when p_condition ? 'dim' and p_condition ? 'key'
                     then count(*) filter (where public.portfolio_fact_in(p_condition->>'dim', p_condition->>'key', f.r)) end,
    'position_ids', coalesce((select jsonb_agg(id order by placed_at, id) from (select id, placed_at from f where v is not null order by placed_at, id limit 1000) q), '[]'::jsonb))
    from f
$$;

create or replace function public.portfolio_experiments_record_guard() returns trigger
language plpgsql as $$
declare len interval; z text;
begin
  if tg_op = 'INSERT' then
    new.success_criteria := nullif(btrim(new.success_criteria), '');
    new.result := null; new.conclusion := null; new.concluded_at := null; new.result_methodology := null;
    new.reflection := null; new.reflected_at := null;
    z := public.portfolio_tz(new.tz); new.tz := z;
    /* the baseline the experiment will be judged against, frozen now: the
       same length of time just before it starts */
    if auth.uid() is not null then
      perform public.portfolio_facts_fresh(z);
      len := new.ends_at - new.starts_at;
      new.baseline := public.portfolio_experiment_window(new.metric, new.condition, new.starts_at - len, new.starts_at, z)
                      || jsonb_build_object('frozen_at', now(), 'methodology', public.portfolio_methodology_current('EXPERIMENT_TEST'));
    else
      new.baseline := null;
    end if;
    return new;
  end if;
  new.success_criteria := old.success_criteria; new.baseline := old.baseline; new.tz := old.tz;
  if old.conclusion is not null or not public.portfolio_writer_is('experiment') then
    new.result := old.result; new.conclusion := old.conclusion; new.concluded_at := old.concluded_at; new.result_methodology := old.result_methodology;
  end if;
  /* the reflection is written once, after the experiment has ended */
  if old.reflection is not null or new.status = 'ACTIVE' then
    new.reflection := old.reflection; new.reflected_at := old.reflected_at;
  elsif new.reflection is distinct from old.reflection then
    new.reflection := nullif(btrim(new.reflection), ''); new.reflected_at := case when new.reflection is not null then now() end;
  end if;
  return new;
end $$;
drop trigger if exists portfolio_experiments_record_trg on public.portfolio_experiments;
create trigger portfolio_experiments_record_trg before insert or update on public.portfolio_experiments
  for each row execute function public.portfolio_experiments_record_guard();

-- the evidence an experiment is judged on: the window and the frozen
-- baseline, computed here. The page runs the pre-registered test on exactly
-- these moments (lib/edgedesk_portfolio_process.js evaluateExperiment).
create or replace function public.portfolio_experiment_evidence(p_id uuid)
returns jsonb language plpgsql volatile set jit = off as $$
declare e record; z text; w jsonb;
begin
  select * into e from public.portfolio_experiments where id = p_id and user_id = auth.uid();
  if not found then raise exception 'portfolio: no such experiment' using errcode = 'P0002'; end if;
  z := public.portfolio_facts_fresh(coalesce(e.tz, 'UTC'));
  w := public.portfolio_experiment_window(e.metric, e.condition, e.starts_at, least(coalesce(e.ended_at, e.ends_at), now()), z);
  return jsonb_build_object('experiment', e.id, 'metric', e.metric, 'min_sample', e.min_sample, 'window', w,
    'baseline', coalesce(e.baseline, public.portfolio_experiment_window(e.metric, e.condition, e.starts_at - (e.ends_at - e.starts_at), e.starts_at, z)
                                     || jsonb_build_object('frozen_at', null, 'computed_at_conclusion', true)),
    'methodology', public.portfolio_methodology_current('EXPERIMENT_TEST'));
end $$;
