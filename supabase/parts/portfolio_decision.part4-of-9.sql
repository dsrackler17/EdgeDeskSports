-- portfolio_decision -- part 4 of 9.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. CONTEXT, PER POSITION — the inputs every later section reads
-- ─────────────────────────────────────────────────────────────────────────────
-- for each of the caller's cached facts: its context quality and the edge
-- capture inputs (decision price: the snapshot's, else the journal's
-- research price recorded before the event)
create or replace function public.portfolio_context(p_tz text)
returns table (id uuid, quality text, snapshot_pre boolean, snapshot_model boolean, snapshot_market boolean, decision_pre boolean,
  price_ref_pre boolean, market_ctx boolean, origin text, origin_ref text, saved_at timestamptz, recorded_at timestamptz,
  ref_price numeric, ref_line numeric, close_price numeric, close_line numeric, prob numeric, entry_line numeric, ou text)
language sql stable as $$
  select c.id,
         public.portfolio_context_quality(x.snapshot_pre, x.snapshot_model, x.snapshot_market, x.decision_pre, x.price_ref_pre, x.market_ctx),
         x.snapshot_pre, x.snapshot_model, x.snapshot_market, x.decision_pre, x.price_ref_pre, x.market_ctx,
         s.origin, s.origin_ref, s.saved_at, s.recorded_at,
         case when c.platform_type = 'PREDICTION_MARKET' then coalesce((s.market->>'price')::numeric, case when c.research_pre_event then j.research_price end)
              else coalesce((s.market->>'odds_decimal')::numeric, case when c.research_pre_event then j.research_odds_decimal end) end,
         case when s.market ? 'odds_decimal' or s.market ? 'price' then (s.market->>'line')::numeric when c.research_pre_event then j.research_line end,
         case when c.platform_type = 'PREDICTION_MARKET' then j.closing_price else j.closing_odds_decimal end,
         j.closing_line,
         case when c.model_pre_event then j.model_probability
              when x.snapshot_pre then (s.edgedesk->>'probability')::numeric end,
         p.line, public.portfolio_ou_direction(p.selection, p.side)
    from public.portfolio_facts_cache c
    join public.portfolio_positions p on p.id = c.id
    left join public.portfolio_journal_entries j on j.position_id = c.id
    left join public.portfolio_decision_snapshots s on s.position_id = c.id
    cross join lateral (select
           (s.position_id is not null and s.recorded_at < least(coalesce(p.event_start_at, 'infinity'::timestamptz), coalesce(p.settled_at, 'infinity'::timestamptz))) as snapshot_pre,
           (s.edgedesk ? 'probability' or s.edgedesk ? 'fair_odds_decimal' or s.edgedesk ? 'fair_line') as snapshot_model,
           (s.market ? 'odds_decimal' or s.market ? 'price') as snapshot_market,
           (j.decision_recorded_at is not null and j.decision_recorded_at < least(coalesce(p.event_start_at, 'infinity'::timestamptz), coalesce(p.settled_at, 'infinity'::timestamptz))) as decision_pre,
           (coalesce(c.research_pre_event, false)
             or (coalesce(j.opening_odds_decimal, j.opening_price) is not null and j.decision_recorded_at is not null
                 and j.decision_recorded_at < least(coalesce(p.event_start_at, 'infinity'::timestamptz), coalesce(p.settled_at, 'infinity'::timestamptz)))) as price_ref_pre,
           (coalesce(j.closing_odds_decimal, j.closing_price, j.closing_line, j.opening_odds_decimal, j.opening_price, j.opening_line) is not null
             or exists (select 1 from public.portfolio_market_path mp where mp.position_id = c.id and mp.source in ('EDGEDESK_CAPTURE', 'book_quote_ticks', 'PLATFORM')
                          and mp.kind <> 'ENTRY')) as market_ctx) x
   where c.user_id = auth.uid() and c.tz = public.portfolio_tz(p_tz)
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. OUTCOME CLASSES — process and result together, persisted, append-only
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.portfolio_outcome_classes (
  id                   bigint      generated always as identity primary key,
  position_id          uuid        not null,
  user_id              uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  classified_at        timestamptz not null default now(),
  methodology_version  text        not null,
  process_methodology  text        not null,
  tz                   text        not null,
  class                text        not null,
  result               text        null,
  process_score        numeric     null,
  grade                text        null,
  context_quality      text        not null,
  components           jsonb       not null default '{}'::jsonb,
  inputs_hash          text        not null,
  constraint portfolio_outcome_position_fk foreign key (position_id, user_id)
    references public.portfolio_positions (id, user_id) on delete cascade,
  constraint portfolio_outcome_class check (class in ('GOOD_WIN', 'GOOD_LOSS', 'BAD_WIN', 'BAD_LOSS', 'AVERAGE_PROCESS', 'NOT_CLASSIFIED', 'NOT_APPLICABLE')),
  constraint portfolio_outcome_quality check (context_quality in ('FULL', 'STRONG', 'PARTIAL', 'RESULT_ONLY'))
);
comment on table public.portfolio_outcome_classes is
  'APPEND-ONLY. GOOD_WIN / GOOD_LOSS / BAD_WIN / BAD_LOSS from the process grade and the result together, never the result alone. A new row only when the graded inputs or the methodology change; the latest row is current, earlier rows are history.';
create unique index if not exists portfolio_outcome_once on public.portfolio_outcome_classes (position_id, methodology_version, inputs_hash);
create index if not exists portfolio_outcome_user on public.portfolio_outcome_classes (user_id, position_id, classified_at desc);

-- the derived tables take writes only from their own functions: each sets a
-- transaction-local marker that a request through the API cannot set
create or replace function public.portfolio_writer_is(p_writer text)
returns boolean language sql stable as $$
  select current_user in ('service_role', 'postgres', 'supabase_admin') or coalesce(current_setting('portfolio.writer', true), '') = p_writer
$$;

create or replace function public.portfolio_outcome_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'portfolio: an outcome classification is never rewritten; a changed grade writes a new one' using errcode = '42501';
  end if;
  if not public.portfolio_writer_is('classify') then
    raise exception 'portfolio: outcome classes are computed by portfolio_classify_outcomes(), not written' using errcode = '42501';
  end if;
  if auth.uid() is not null then new.user_id := auth.uid(); end if;
  new.classified_at := now();
  return new;
end $$;
drop trigger if exists portfolio_outcome_guard_trg on public.portfolio_outcome_classes;
create trigger portfolio_outcome_guard_trg before insert or update on public.portfolio_outcome_classes
  for each row execute function public.portfolio_outcome_guard();

-- classify every settled position of the caller whose graded inputs have no
-- row yet under the current methodology; returns how many were written
create or replace function public.portfolio_classify_outcomes(p_tz text default null)
returns int language plpgsql volatile set jit = off as $$
declare z text := public.portfolio_facts_fresh(p_tz); n int; mv text := public.portfolio_methodology_current('OUTCOME_CLASS');
  pv text := public.portfolio_methodology_current('PROCESS_SCORE');
begin
  if auth.uid() is null then return 0; end if;
  perform set_config('portfolio.writer', 'classify', true);
  insert into public.portfolio_outcome_classes (position_id, user_id, methodology_version, process_methodology, tz, class, result, process_score,
      grade, context_quality, components, inputs_hash)
  select q.id, auth.uid(), mv, pv, z, q.cls, q.result, q.process_score, q.grade, q.quality, q.comp,
         public.portfolio_sha256(concat_ws('|', mv, pv, q.cls, q.result, q.process_score::text, q.quality, q.comp::text))
    from (select c.id, c.result, c.process_score, c.grade, x.quality,
                 public.portfolio_outcome_class(c.status, c.result, c.process_score, x.quality) as cls,
                 jsonb_strip_nulls(jsonb_build_object('clv', c.s_clv, 'model', c.s_model, 'price', c.s_price, 'sizing', c.s_sizing,
                   'timing', c.s_timing, 'rules', c.s_rules, 'market', c.s_market)) as comp
            from public.portfolio_facts_cached(null, null, z, null) c
            join public.portfolio_context(z) x on x.id = c.id
           where c.status <> 'OPEN') q
   where not exists (select 1 from public.portfolio_outcome_classes o
                      where o.position_id = q.id and o.methodology_version = mv
                        and o.inputs_hash = public.portfolio_sha256(concat_ws('|', mv, pv, q.cls, q.result, q.process_score::text, q.quality, q.comp::text)))
  on conflict do nothing;
  get diagnostics n = row_count;
  perform set_config('portfolio.writer', '', true);
  return n;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. THE PERSONAL BASELINE — the first 30 graded positions, frozen once
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.portfolio_baselines (
  user_id              uuid        not null references auth.users(id) on delete cascade,
  methodology_version  text        not null,
  frozen_at            timestamptz not null default now(),
  tz                   text        not null,
  n                    int         not null,
  first_placed         timestamptz not null,
  last_placed          timestamptz not null,
  position_ids         uuid[]      not null,
  moments              jsonb       not null,
  primary key (user_id, methodology_version)
);
comment on table public.portfolio_baselines is
  'The reader''s first graded positions (baseline_v1: 30), frozen once reached. What later process change is measured against. Never rewritten.';

create or replace function public.portfolio_baseline_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then raise exception 'portfolio: a frozen baseline is never rewritten' using errcode = '42501'; end if;
  if not public.portfolio_writer_is('baseline') then
    raise exception 'portfolio: the baseline is computed by portfolio_baseline(), not written' using errcode = '42501';
  end if;
  if auth.uid() is not null then new.user_id := auth.uid(); end if;
  new.frozen_at := now();
  return new;
end $$;
drop trigger if exists portfolio_baseline_guard_trg on public.portfolio_baselines;
create trigger portfolio_baseline_guard_trg before insert or update on public.portfolio_baselines
  for each row execute function public.portfolio_baseline_guard();

-- moments (n, sum, sum of squares) of the three metrics over a set of facts
create or replace function public.portfolio_moments(p_ids uuid[], p_tz text)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'ps', jsonb_build_array(count(c.process_score), coalesce(sum(c.process_score), 0), coalesce(sum(c.process_score * c.process_score), 0)),
    'clv', jsonb_build_array(count(c.clv_pct), coalesce(sum(c.clv_pct), 0), coalesce(sum(c.clv_pct * c.clv_pct), 0)),
    'ret', jsonb_build_array(count(c.ret), coalesce(sum(c.ret), 0), coalesce(sum(c.ret * c.ret), 0)))
    from public.portfolio_facts_cache c where c.user_id = auth.uid() and c.tz = p_tz and c.id = any (p_ids)
$$;

-- the baseline, frozen the first time 30 graded positions exist; before that
-- a provisional one (status BUILDING) that is not stored. With it, the most
-- recent graded positions placed after it (up to 30): the comparison the
-- page tests with Welch's test (lib/edgedesk_decision.js changeStatus).
create or replace function public.portfolio_baseline(p_tz text default null)
returns jsonb language plpgsql volatile set jit = off as $$
declare z text := public.portfolio_facts_fresh(p_tz); mv text := public.portfolio_methodology_current('BASELINE'); b record; ids uuid[];
  recent uuid[]; n int; need int := 30;
begin
  if auth.uid() is null then return null; end if;
  select * into b from public.portfolio_baselines where user_id = auth.uid() and methodology_version = mv;
  if b.user_id is null then
    select array_agg(id order by placed_at, id) into ids from (
      select c.id, c.placed_at from public.portfolio_facts_cache c
       where c.user_id = auth.uid() and c.tz = z and c.process_score is not null order by c.placed_at, c.id limit need) q;
    n := coalesce(array_length(ids, 1), 0);
    if n < need then
      return jsonb_build_object('status', 'BUILDING', 'methodology', mv, 'n', n, 'needed', need - n,
        'moments', case when n > 0 then public.portfolio_moments(ids, z) end);
    end if;
    perform set_config('portfolio.writer', 'baseline', true);
    insert into public.portfolio_baselines (user_id, methodology_version, tz, n, first_placed, last_placed, position_ids, moments)
    select auth.uid(), mv, z, n, min(c.placed_at), max(c.placed_at), ids, public.portfolio_moments(ids, z)
      from public.portfolio_facts_cache c where c.user_id = auth.uid() and c.tz = z and c.id = any (ids)
    on conflict do nothing;
    perform set_config('portfolio.writer', '', true);
    select * into b from public.portfolio_baselines where user_id = auth.uid() and methodology_version = mv;
  end if;
  select array_agg(id) into recent from (
    select c.id from public.portfolio_facts_cache c
     where c.user_id = auth.uid() and c.tz = z and c.process_score is not null and c.placed_at > b.last_placed
       and not (c.id = any (b.position_ids))
     order by c.placed_at desc, c.id desc limit 30) q;
  return jsonb_build_object('status', 'FROZEN', 'methodology', mv, 'frozen_at', b.frozen_at, 'n', b.n, 'first_placed', b.first_placed,
    'last_placed', b.last_placed, 'moments', b.moments,
    'recent', jsonb_build_object('n', coalesce(array_length(recent, 1), 0),
      'moments', case when recent is not null then public.portfolio_moments(recent, z) end,
      'from', (select min(c.placed_at) from public.portfolio_facts_cache c where c.user_id = auth.uid() and c.tz = z and c.id = any (recent)),
      'to', (select max(c.placed_at) from public.portfolio_facts_cache c where c.user_id = auth.uid() and c.tz = z and c.id = any (recent))));
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. PROCESS MEMORY — patterns, when first detected, then and now
-- ─────────────────────────────────────────────────────────────────────────────
-- the key a cached fact takes in a breakdown dimension: the same expressions
-- as portfolio_cells(), held equal by test
create or replace function public.portfolio_fact_key(p_dim text, c public.portfolio_facts_cache)
returns text language sql immutable as $$
  select case p_dim
    when 'all' then 'all'
    when 'platform' then c.platform
    when 'platform_type' then c.platform_type
    when 'sport' then coalesce(c.sport, 'UNKNOWN')
    when 'league' then coalesce(c.league, 'UNKNOWN')
    when 'position_type' then c.position_type
    when 'source' then c.source
    when 'timing' then c.timing_bucket
    when 'placed_dow' then c.placed_dow::text
    when 'event_dow' then coalesce(c.event_dow::text, 'UNKNOWN')
    when 'hour' then c.hour_band
    when 'odds' then c.odds_band
    when 'units' then c.units_band
    when 'decision_source' then coalesce(c.decision_source, 'UNRECORDED')
    when 'planned' then case c.planned when true then 'PLANNED' when false then 'UNPLANNED' else 'UNTAGGED' end
    when 'after' then c.after_result
    when 'session' then case when c.session_order = 1 then 'FIRST' when c.session_order <= 3 then 'SECOND_THIRD' else 'FOURTH_PLUS' end
    when 'repeat' then coalesce(c.would_repeat, 'UNREVIEWED')
    when 'evidence' then c.evidence
    when 'stake_type' then c.stake_type
    when 'sport_type' then coalesce(c.sport, 'UNKNOWN') || ' · ' || c.position_type
    when 'timing_type' then c.timing_bucket || ' · ' || c.position_type
    when 'platform_type_pos' then c.platform || ' · ' || c.position_type
  end
$$;
create or replace function public.portfolio_fact_in(p_dim text, p_key text, c public.portfolio_facts_cache)
returns boolean language sql immutable as $$
  select case when p_dim = 'tag' then p_key = any (coalesce(c.decision_tags, array['UNTAGGED']::text[]))
              else public.portfolio_fact_key(p_dim, c) = p_key end
$$;
