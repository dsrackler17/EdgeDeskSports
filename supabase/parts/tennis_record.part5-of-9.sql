-- tennis_record -- part 5 of 9.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- Re-running the same model over the same features and the same market snapshot
-- is a no-op rather than a second row. A unique INDEX with coalesce, not a
-- UNIQUE constraint: both snapshot columns are nullable and two nulls would
-- otherwise be distinct, so a model re-run before any market existed would
-- write a second prediction every time.
create unique index if not exists tennis_pred_unique_idx on tennis.model_predictions
  (match_scope, match_ref, model_version,
   coalesce(feature_snapshot_at, '-infinity'::timestamptz),
   coalesce(market_snapshot_id, -1));
create index if not exists tennis_pred_match_idx  on tennis.model_predictions (match_scope, match_ref, generated_at desc);
create index if not exists tennis_pred_model_idx  on tennis.model_predictions (model_version, generated_at desc);
create index if not exists tennis_pred_grade_idx  on tennis.model_predictions (research_grade, generated_at desc);
create index if not exists tennis_pred_tour_idx   on tennis.model_predictions (tour, generated_at desc);

create or replace function tennis.freeze_prediction()
returns trigger
language plpgsql
as $$
begin
  raise exception using errcode = 'restrict_violation',
    message = 'tennis.model_predictions is append-only: a prediction cannot be '
              || lower(tg_op) || 'd after it is written',
    hint = 'Write a new prediction row. The research layer '
           '(tennis.research_opportunities) is the mutable surface; the '
           'prediction that produced it is evidence and stays as it was.';
end $$;
drop trigger if exists tennis_pred_freeze on tennis.model_predictions;
create trigger tennis_pred_freeze before update or delete on tennis.model_predictions
  for each row execute function tennis.freeze_prediction();

-- ===========================================================================
-- LAYER 8 — RESEARCH OPPORTUNITIES. The mutable surface.
--
-- Separate from predictions on purpose: a prediction is what the model said,
-- an opportunity is what is still worth reading right now. It expires, it gets
-- superseded, it gets withdrawn when the data behind it goes stale — and none
-- of that may rewrite the prediction that produced it.
--
-- RESEARCH, NOT PICKS. There is no stake column, no "play" column and no
-- ranking by expected profit. `reason_codes` says why a row is here and
-- `exclusion_reasons` says what would stop a careful reader trusting it.
-- ===========================================================================
create table if not exists tennis.research_opportunities (
  opportunity_id     uuid primary key default gen_random_uuid(),
  match_scope        text not null default 'live',
  match_ref          text not null,
  tour               text,
  prediction_id      uuid references tennis.model_predictions (prediction_id) on delete set null,
  model_version      text references tennis.model_registry (model_version) on delete set null,
  market_type        text not null,
  selection          text not null,
  selection_player_id text references tennis.players (player_id) on delete set null,
  sportsbook         text,
  line               numeric(7,2),
  model_prob         numeric(6,5),
  market_prob        numeric(6,5),
  fair_odds_decimal  numeric(10,4),
  fair_odds_american integer,
  market_odds_decimal numeric(10,4),
  market_odds_american integer,
  estimated_edge     numeric(7,5),
  expected_value     numeric(8,5),
  confidence         numeric(4,3),
  data_quality_score numeric(4,3),
  market_quality_score numeric(4,3),
  reason_codes       text[] not null default '{}'::text[],
  exclusion_reasons  text[] not null default '{}'::text[],
  research_grade     text not null default 'research',
  status             text not null default 'open',
  generated_at       timestamptz not null default now(),
  expires_at         timestamptz,
  superseded_at      timestamptz,
  superseded_by      uuid references tennis.research_opportunities (opportunity_id) on delete set null,
  source_key         text not null default 'edgedesk',
  updated_at         timestamptz not null default now(),
  constraint tennis_ro_scope_shape check (match_scope in ('live','archive')),
  constraint tennis_ro_status_shape
    check (status in ('open','expired','superseded','withdrawn','settled')),
  constraint tennis_ro_grade_shape
    check (research_grade in ('research','provisional','excluded')),
  constraint tennis_ro_dq_shape check (data_quality_score is null or (data_quality_score between 0 and 1)),
  constraint tennis_ro_mq_shape check (market_quality_score is null or (market_quality_score between 0 and 1)),
  constraint tennis_ro_source_fk
    foreign key (source_key) references tennis.source_licenses (source_key) on delete restrict
);
create index if not exists tennis_ro_open_idx on tennis.research_opportunities (status, generated_at desc)
  where status = 'open';
create index if not exists tennis_ro_match_idx on tennis.research_opportunities (match_scope, match_ref, generated_at desc);
create index if not exists tennis_ro_tour_idx on tennis.research_opportunities (tour, status, generated_at desc);
create index if not exists tennis_ro_edge_idx on tennis.research_opportunities (status, estimated_edge desc nulls last);
drop trigger if exists tennis_ro_touch on tennis.research_opportunities;
create trigger tennis_ro_touch before update on tennis.research_opportunities
  for each row execute function tennis.touch_updated_at();

-- ===========================================================================
-- LAYER 10 — PUBLIC RECORD and CALIBRATION.
--
-- A published prediction is written here AT PUBLICATION TIME and is never
-- edited afterwards except to record what actually happened. That is the whole
-- promise of a public record: the claim is frozen before the result exists, and
-- settlement writes the result beside it rather than over it.
--
-- This is the tennis half of the boundary public.public_brief_closes already
-- draws for every other sport: the live board is behind the paywall, the
-- history is public.
-- ===========================================================================
create table if not exists tennis.prediction_record (
  record_id          uuid primary key default gen_random_uuid(),
  prediction_id      uuid references tennis.model_predictions (prediction_id) on delete set null,
  match_scope        text not null default 'live',
  match_ref          text not null,
  archive_match_id   text references tennis.matches (match_id) on delete set null,
  tour               text,
  tournament_name    text,
  surface            text,
  round              text,
  model_version      text not null references tennis.model_registry (model_version) on delete restrict,
  feature_version    text,
  published_at       timestamptz not null default now(),
  scheduled_at       timestamptz,
  player_a_id        text,
  player_b_id        text,
  player_a_name      text,
  player_b_name      text,
  prob_a             numeric(6,5) not null,
  fair_odds_a_decimal numeric(10,4),
  market_prob_a      numeric(6,5),
  market_odds_a_decimal numeric(10,4),
  market_book        text,
  closing_prob_a     numeric(6,5),
  closing_odds_a_decimal numeric(10,4),
  confidence         numeric(4,3),
  confidence_bucket  text,
  calibration_bucket text,
  research_grade     text not null default 'research',
  -- settlement, written once the match is final
  settled_at         timestamptz,
  winner_id          text,
  outcome_a          boolean,                     -- did player A win?
  brier              numeric(8,6),
  log_loss           numeric(10,6),
  clv                numeric(8,5),
  beat_close         boolean,
  settle_source      text,
  constraint tennis_rec_scope_shape check (match_scope in ('live','archive')),
  constraint tennis_rec_prob_shape check (prob_a > 0 and prob_a < 1),
  constraint tennis_rec_grade_shape check (research_grade in ('research','provisional','excluded')),
  -- one published record per match per model version. A second publication of
  -- the same claim is the same claim.
  constraint tennis_rec_unique unique (match_scope, match_ref, model_version)
);
create index if not exists tennis_rec_published_idx on tennis.prediction_record (published_at desc);
create index if not exists tennis_rec_settled_idx   on tennis.prediction_record (settled_at desc nulls last);
create index if not exists tennis_rec_model_idx     on tennis.prediction_record (model_version, settled_at desc nulls last);
create index if not exists tennis_rec_tour_idx      on tennis.prediction_record (tour, surface, settled_at desc nulls last);
create index if not exists tennis_rec_open_idx      on tennis.prediction_record (scheduled_at) where settled_at is null;

-- A published claim cannot be edited. Settlement may fill the result columns
-- exactly once; nothing may change the probability, the price or the model
-- that produced them.
create or replace function tennis.freeze_published_record()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'restrict_violation',
      message = 'tennis.prediction_record is immutable: a published prediction cannot be deleted';
  end if;
  if new.prob_a is distinct from old.prob_a
     or new.model_version is distinct from old.model_version
     or new.published_at is distinct from old.published_at
     or new.match_ref is distinct from old.match_ref
     or new.player_a_id is distinct from old.player_a_id
     or new.player_b_id is distinct from old.player_b_id
     or new.fair_odds_a_decimal is distinct from old.fair_odds_a_decimal
     or new.market_prob_a is distinct from old.market_prob_a then
    raise exception using errcode = 'restrict_violation',
      message = 'tennis.prediction_record: the published claim is immutable',
      hint = 'Settlement may write winner_id, outcome_a, settled_at, brier, '
             'log_loss, clv, beat_close and the closing price. Nothing else.';
  end if;
  if old.settled_at is not null and new.settled_at is distinct from old.settled_at then
    raise exception using errcode = 'restrict_violation',
      message = 'tennis.prediction_record: this record is already settled',
      hint = 'A settled result is not re-settled. Correct it by recording a '
             'data-quality issue, not by rewriting history.';
  end if;
  return new;
end $$;
drop trigger if exists tennis_rec_freeze on tennis.prediction_record;
create trigger tennis_rec_freeze before update or delete on tennis.prediction_record
  for each row execute function tennis.freeze_published_record();

-- The published performance surface. Counts and scores only — no ROI, because
-- ROI without the price that was actually available and the sample it came
-- from is a number that flatters whoever publishes it. CLV is published where
-- a closing price exists and says how often it does.
create or replace view tennis.public_record_summary
with (security_invoker = true) as
  select r.model_version,
         r.tour,
         r.surface,
         r.confidence_bucket,
         count(*)::integer                                        as predictions,
         count(*) filter (where r.settled_at is not null)::integer as settled,
         round(avg(r.brier) filter (where r.settled_at is not null)::numeric, 5)    as brier,
         round(avg(r.log_loss) filter (where r.settled_at is not null)::numeric, 5) as log_loss,
         round(avg(case when r.outcome_a then 1.0 else 0.0 end)
               filter (where r.settled_at is not null)::numeric, 4)                 as outcome_rate,
         round(avg(r.prob_a) filter (where r.settled_at is not null)::numeric, 4)   as mean_prob,
         count(*) filter (where r.clv is not null)::integer                         as clv_sample,
         round(avg(r.clv) filter (where r.clv is not null)::numeric, 5)             as mean_clv,
         count(*) filter (where r.beat_close)::integer                              as beat_close,
         min(r.published_at) as first_published,
         max(r.published_at) as last_published,
         -- a sample below this is not a measurement and the page must say so
         (count(*) filter (where r.settled_at is not null) < 100) as small_sample
    from tennis.prediction_record r
   group by r.model_version, r.tour, r.surface, r.confidence_bucket;

create or replace view tennis.public_record_calibration
with (security_invoker = true) as
  select r.model_version,
         r.tour,
         width_bucket(r.prob_a, 0, 1, 10) as bucket,
         round((width_bucket(r.prob_a, 0, 1, 10) - 0.5) / 10.0, 3) as bucket_midpoint,
         count(*)::integer as n,
         round(avg(r.prob_a)::numeric, 4) as mean_predicted,
         round(avg(case when r.outcome_a then 1.0 else 0.0 end)::numeric, 4) as observed_rate
    from tennis.prediction_record r
   where r.settled_at is not null
   group by r.model_version, r.tour, width_bucket(r.prob_a, 0, 1, 10);

-- ===========================================================================
-- ENTITLEMENT. One authority, reused rather than re-implemented.
--
-- public.community_is_entitled(uuid) is the project's entitlement rule: the
-- owner comp, the active/trialing period, and Stripe's 21-day past_due grace.
-- This delegates to it wherever it is installed, so tennis can never drift
-- from what the rest of the product means by "subscriber". The fallback exists
-- only so this file applies to a database that has tennis but not yet the
-- community contract — and it evaluates the identical predicate against
-- public.subscriptions rather than inventing a second rule.
-- ===========================================================================
create or replace function tennis.viewer_is_entitled()
returns boolean
language plpgsql
stable
security definer
set search_path = public, tennis, pg_temp
as $$
declare
  uid uuid;
  ok  boolean;
begin
  begin
    uid := auth.uid();
  exception when others then
    return false;
  end;
  if uid is null then return false; end if;

  if to_regprocedure('public.community_is_entitled(uuid)') is not null then
    execute 'select public.community_is_entitled($1)' into ok using uid;
    return coalesce(ok, false);
  end if;

  if to_regclass('public.subscriptions') is null then return false; end if;
  execute $q$
    select exists (
      select 1 from public.subscriptions s
       where s.user_id = $1
         and ( (s.status = 'active' and coalesce(s.price_id, '') in ('owner_comp'))
            or (s.status in ('active','trialing')
                and (s.current_period_end is null or s.current_period_end >= now()))
            or (s.status = 'past_due'
                and (s.current_period_end is null or now() - s.current_period_end < interval '21 days')) )
    )
  $q$ into ok using uid;
  return coalesce(ok, false);
end $$;
revoke all on function tennis.viewer_is_entitled() from public;
grant execute on function tennis.viewer_is_entitled() to anon, authenticated, service_role;
