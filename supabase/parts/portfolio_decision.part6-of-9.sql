-- portfolio_decision -- part 6 of 9.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- conclude an ended experiment, once. The server recomputes the evidence and
-- refuses a conclusion the evidence does not allow: SUPPORTED needs the
-- interval above zero and the window mean above the baseline; fewer
-- positions than pre-registered on either side is INCONCLUSIVE, whatever
-- the page says.
create or replace function public.portfolio_conclude_experiment(p_id uuid, p_test jsonb)
returns jsonb language plpgsql volatile set jit = off as $$
declare e record; ev jsonb; wm jsonb; bm jsonb; wn numeric; bn numeric; diff numeric; lo numeric; hi numeric; st text; claimed text; ended boolean;
begin
  select * into e from public.portfolio_experiments where id = p_id and user_id = auth.uid() for update;
  if not found then raise exception 'portfolio: no such experiment' using errcode = 'P0002'; end if;
  if e.conclusion is not null then return jsonb_build_object('conclusion', e.conclusion, 'result', e.result, 'already', true); end if;
  ended := e.status <> 'ACTIVE' or e.ends_at <= now();
  if not ended then raise exception 'portfolio: an experiment is concluded once its window has ended' using errcode = '55000'; end if;
  ev := public.portfolio_experiment_evidence(p_id);
  /* an experiment started before baselines were frozen: its baseline window
     is computed now, and the result says so */
  if e.baseline is null then
    e.baseline := public.portfolio_experiment_window(e.metric, e.condition, e.starts_at - (e.ends_at - e.starts_at), e.starts_at,
                    public.portfolio_tz(coalesce(e.tz, 'UTC'))) || jsonb_build_object('frozen_at', null, 'computed_at_conclusion', true);
  end if;
  wm := ev->'window'->'moments'; bm := e.baseline->'moments';
  wn := (wm->>0)::numeric; bn := (bm->>0)::numeric;
  diff := case when wn > 0 and bn > 0 then (wm->>1)::numeric / wn - (bm->>1)::numeric / bn end;
  claimed := upper(coalesce(p_test->>'status', ''));
  lo := public.portfolio_j_num(p_test, 'ci_lo', -1000000, 1000000); hi := public.portfolio_j_num(p_test, 'ci_hi', -1000000, 1000000);
  st := case when wn < e.min_sample or bn < e.min_sample or diff is null then 'INCONCLUSIVE'
             when claimed = 'SUPPORTED' and lo > 0 and diff > 0 then 'SUPPORTED'
             when claimed = 'NOT_SUPPORTED' and ((hi < 0 and diff < 0) or diff <= 0) then 'NOT_SUPPORTED'
             else 'INCONCLUSIVE' end;
  perform set_config('portfolio.writer', 'experiment', true);
  update public.portfolio_experiments set status = case when status = 'ACTIVE' then 'ENDED' else status end,
         result = jsonb_build_object('window', ev->'window', 'baseline', e.baseline, 'diff', diff,
           'test', jsonb_strip_nulls(jsonb_build_object('ci_lo', lo, 'ci_hi', hi, 'p', public.portfolio_j_num(p_test, 'p', 0, 1),
             'df', public.portfolio_j_num(p_test, 'df', 0, 100000000))), 'claimed', nullif(claimed, '')),
         conclusion = st, concluded_at = now(), result_methodology = ev->>'methodology'
   where id = p_id;
  perform set_config('portfolio.writer', '', true);
  select * into e from public.portfolio_experiments where id = p_id;
  return jsonb_build_object('conclusion', e.conclusion, 'result', e.result, 'already', false);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. CARD LIFECYCLE — what happened to each saved opportunity, append-only.
--     A skipped or removed entry is never a position.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.portfolio_card_events (
  id           bigint      generated always as identity primary key,
  user_id      uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  entry_id     text        not null,
  event        text        not null,
  at           timestamptz not null default now(),
  position_id  uuid        null,
  detail       jsonb       not null default '{}'::jsonb,
  constraint portfolio_card_events_shape check (event in ('ADDED', 'RESEARCH_VIEWED', 'CONSIDERED', 'RECORDED', 'REMOVED')
    and length(entry_id) between 1 and 120 and jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 1024)
);
comment on table public.portfolio_card_events is
  'APPEND-ONLY. The life of a Card entry: added, research viewed, considered (Before You Enter opened), recorded (a position), removed. RECORDED is written only by the decision snapshot. Private to its reader.';
create unique index if not exists portfolio_card_events_once on public.portfolio_card_events (user_id, entry_id, event)
  where event in ('ADDED', 'RECORDED', 'REMOVED');
create index if not exists portfolio_card_events_user on public.portfolio_card_events (user_id, at desc);

create or replace function public.portfolio_card_events_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then raise exception 'portfolio: a Card event is never rewritten' using errcode = '42501'; end if;
  if auth.uid() is not null then new.user_id := auth.uid(); end if;
  new.at := now();
  if new.event = 'RECORDED' and not public.portfolio_writer_is('card_recorded') then
    raise exception 'portfolio: a Card entry is recorded by recording its position' using errcode = '42501';
  end if;
  if new.event <> 'RECORDED' then new.position_id := null; end if;
  /* the detail is labels, never money */
  new.detail := jsonb_strip_nulls(jsonb_build_object('decision', public.portfolio_j_text(new.detail, 'decision', 20),
    'sport', public.portfolio_j_text(new.detail, 'sport', 20), 'type', public.portfolio_j_text(new.detail, 'type', 20),
    'surface', public.portfolio_j_text(new.detail, 'surface', 40)));
  return new;
end $$;
drop trigger if exists portfolio_card_events_guard_trg on public.portfolio_card_events;
create trigger portfolio_card_events_guard_trg before insert or update on public.portfolio_card_events
  for each row execute function public.portfolio_card_events_guard();

create or replace function public.portfolio_card_recorded(p_user uuid, p_entry text, p_position uuid, p_decision text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  /* only the snapshot that names this entry records it */
  if not exists (select 1 from public.portfolio_decision_snapshots s where s.position_id = p_position and s.user_id = p_user
                   and s.origin = 'CARD' and s.origin_ref = p_entry and (auth.uid() is null or s.user_id = auth.uid())) then
    return;
  end if;
  perform set_config('portfolio.writer', 'card_recorded', true);
  insert into public.portfolio_card_events (user_id, entry_id, event, position_id, detail)
  values (p_user, left(p_entry, 120), 'RECORDED', p_position, jsonb_build_object('decision', p_decision))
  on conflict do nothing;
  perform set_config('portfolio.writer', '', true);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 12. THE DECISION RECORD — one position, canonically:
--     BEFORE · ENTRY · MARKET PATH · RESULT · GRADE · REFLECTION · FOLLOW-UP
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.portfolio_decision_record(p_position uuid, p_tz text default null)
returns jsonb language plpgsql volatile set jit = off as $$
declare z text := public.portfolio_facts_fresh(p_tz); p record; j record; s record; c record; x record; oc record; refl jsonb; path jsonb;
  cev jsonb; exps jsonb; ins jsonb; ec jsonb;
begin
  select * into p from public.portfolio_positions where id = p_position and user_id = auth.uid();
  if not found then raise exception 'portfolio: no such position' using errcode = 'P0002'; end if;
  select * into j from public.portfolio_journal_entries where position_id = p.id;
  select * into s from public.portfolio_decision_snapshots where position_id = p.id;
  select * into c from public.portfolio_facts_cached(null, null, z, null) f where f.id = p.id;
  select * into x from public.portfolio_context(z) q where q.id = p.id;
  select * into oc from public.portfolio_outcome_classes o where o.position_id = p.id order by o.classified_at desc, o.id desc limit 1;
  select coalesce(jsonb_agg(jsonb_build_object('kind', m.kind, 'observed_at', m.observed_at, 'time_basis', m.time_basis, 'source', m.source,
           'book', m.book, 'odds_decimal', m.odds_decimal, 'price', m.price, 'line', m.line) order by m.observed_at, m.id), '[]'::jsonb)
    into path from public.portfolio_market_path m where m.position_id = p.id;
  select coalesce(jsonb_agg(jsonb_build_object('written_at', r.written_at, 'would_repeat', r.would_repeat, 'review_note', r.review_note,
           'library', r.library, 'result_known', r.result_known, 'result', r.result) order by r.written_at, r.id), '[]'::jsonb)
    into refl from public.portfolio_reflections r where r.position_id = p.id;
  select coalesce(jsonb_agg(jsonb_build_object('event', e.event, 'at', e.at) order by e.at, e.id), '[]'::jsonb)
    into cev from public.portfolio_card_events e where e.user_id = auth.uid() and s.origin = 'CARD' and e.entry_id = s.origin_ref;
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'title', e.title, 'metric', e.metric, 'status', e.status, 'conclusion', e.conclusion,
           'starts_at', e.starts_at, 'ends_at', e.ends_at,
           'followed', case when e.condition ? 'dim' and e.condition ? 'key' then (select public.portfolio_fact_in(e.condition->>'dim', e.condition->>'key', fc)
                              from public.portfolio_facts_cache fc where fc.user_id = auth.uid() and fc.tz = z and fc.id = p.id) end)
           order by e.starts_at), '[]'::jsonb)
    into exps from public.portfolio_experiments e
   where e.user_id = auth.uid() and e.starts_at <= p.placed_at and coalesce(e.ended_at, e.ends_at) > p.placed_at;
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'label', i.label, 'kind', i.kind, 'metric', i.metric, 'dim', i.dim, 'key', i.key,
           'first_detected_at', i.first_detected_at) order by i.first_detected_at), '[]'::jsonb)
    into ins from public.portfolio_insights i
   where i.user_id = auth.uid() and exists (select 1 from public.portfolio_insight_observations o where o.insight_id = i.id and p.id = any (o.position_ids)
                                             and o.observed_at = (select max(o2.observed_at) from public.portfolio_insight_observations o2 where o2.insight_id = i.id));
  ec := public.portfolio_edge_capture(p.platform_type, p.position_type, x.ou, c.lead_seconds,
          case when p.platform_type = 'PREDICTION_MARKET' then p.average_entry_price else p.odds_decimal end, p.line,
          x.ref_price, x.ref_line, x.close_price, x.close_line, x.prob);
  return jsonb_build_object(
    'methodology', jsonb_build_object('process', public.portfolio_methodology_current('PROCESS_SCORE'),
      'context_quality', public.portfolio_methodology_current('CONTEXT_QUALITY'), 'edge_capture', public.portfolio_methodology_current('EDGE_CAPTURE'),
      'outcome_class', public.portfolio_methodology_current('OUTCOME_CLASS'), 'snapshot', s.snapshot_version, 'calc', p.calc_version),
    'position', jsonb_build_object('id', p.id, 'platform', p.platform, 'platform_label', p.platform_label, 'platform_type', p.platform_type,
      'position_type', p.position_type, 'sport', p.sport, 'league', p.league, 'event_name', p.event_name, 'event_start_at', p.event_start_at,
      'market_name', p.market_name, 'selection', p.selection, 'side', p.side, 'line', p.line, 'source', p.source),
    'context_quality', coalesce(x.quality, 'RESULT_ONLY'),
    'before', jsonb_build_object(
      'snapshot', case when s.position_id is not null then jsonb_build_object('origin', s.origin, 'origin_ref', s.origin_ref, 'saved_at', s.saved_at,
        'recorded_at', s.recorded_at, 'version', s.snapshot_version, 'edgedesk', s.edgedesk, 'market', s.market, 'user_state', s.user_state,
        'market_freshness', s.market_freshness, 'content_hash', s.content_hash,
        'research_to_decision_seconds', case when s.saved_at is not null then trunc(extract(epoch from (s.recorded_at - s.saved_at)))::bigint end) end,
      'journal', case when j.position_id is not null then jsonb_strip_nulls(jsonb_build_object('decision_source', j.decision_source,
        'planned', j.planned, 'thesis', j.thesis, 'decision_tags', to_jsonb(j.decision_tags), 'model_version', j.model_version,
        'model_probability', j.model_probability, 'model_fair_line', j.model_fair_line, 'model_fair_odds_decimal', j.model_fair_odds_decimal,
        'research_odds_american', j.research_odds_american, 'research_odds_decimal', j.research_odds_decimal, 'research_line', j.research_line,
        'research_price', j.research_price, 'research_at', j.research_at, 'opening_odds_decimal', j.opening_odds_decimal, 'opening_line', j.opening_line,
        'opening_price', j.opening_price, 'unit_size_at_entry', j.unit_size_at_entry, 'max_single_units_at_entry', j.max_single_units_at_entry,
        'max_daily_units_at_entry', j.max_daily_units_at_entry, 'decision_recorded_at', j.decision_recorded_at,
        'model_pre_event', c.model_pre_event, 'research_pre_event', c.research_pre_event)) end,
      'card', cev),
    'entry', jsonb_strip_nulls(jsonb_build_object('placed_at', p.placed_at, 'odds_american', p.odds_american, 'odds_decimal', p.odds_decimal,
      'average_entry_price', p.average_entry_price, 'contracts', p.contracts, 'line', p.line, 'stake', p.stake, 'cost_basis', p.cost_basis,
      'stake_type', p.stake_type, 'currency', p.currency, 'units', c.units, 'lead_seconds', c.lead_seconds, 'timing_bucket', c.timing_bucket)),
    'market_path', path,
    'result', jsonb_strip_nulls(jsonb_build_object('status', p.status, 'result', p.result, 'settled_at', p.settled_at, 'profit_loss', p.profit_loss,
      'closing_source', j.closing_source, 'closing_book', j.closing_book, 'closing_recorded_at', j.closing_recorded_at,
      'closing_odds_decimal', j.closing_odds_decimal, 'closing_line', j.closing_line, 'closing_price', j.closing_price)),
    'grade', jsonb_build_object('process_score', c.process_score, 'grade', c.grade, 'process_weight', c.process_weight, 'evidence', c.evidence,
      'components', jsonb_build_object('clv', c.s_clv, 'model', c.s_model, 'price', c.s_price, 'sizing', c.s_sizing, 'timing', c.s_timing,
        'rules', c.s_rules, 'market', c.s_market),
      'clv_pct', c.clv_pct, 'clv_points', c.clv_points, 'model_ev', c.model_ev, 'price_slip', c.price_slip, 'price_points', c.price_points,
      'rules_applicable', c.rules_applicable, 'rules_followed', c.rules_followed, 'rules_broken', to_jsonb(c.rules_broken),
      'edge_capture', ec,
      'outcome', case when oc.id is not null then jsonb_build_object('class', oc.class, 'classified_at', oc.classified_at,
        'methodology', oc.methodology_version, 'process_score', oc.process_score, 'context_quality', oc.context_quality)
        else jsonb_build_object('class', public.portfolio_outcome_class(p.status, p.result, c.process_score, coalesce(x.quality, 'RESULT_ONLY')),
          'provisional', true) end),
    'reflection', jsonb_build_object('current', case when j.position_id is not null then jsonb_strip_nulls(jsonb_build_object('would_repeat', j.would_repeat,
      'review_note', j.review_note, 'library', j.library, 'reviewed_at', j.reviewed_at)) end, 'history', refl),
    'follow_up', jsonb_build_object('needs_review', p.status <> 'OPEN' and j.would_repeat is null, 'experiments', exps, 'patterns', ins,
      'rules_broken', to_jsonb(c.rules_broken)));
end $$;
