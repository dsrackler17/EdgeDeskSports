-- cfb_market -- part 1 of 2.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- =============================================================================
-- cfb_market — the Postgres half of the CFB market intelligence, price
-- discovery and bet timing layer (docs/cfb-market/DELIVERABLE.md §38).
--
-- WHAT IT IS
--   The market layer's own records, beside the tables it REUSES:
--     quotes            cfb_lab_market_quotes (append-only, the canonical store;
--                       cfb_market_quotes_canonical renders it in the canonical
--                       side format when that table exists)
--     openers / closes  cfb_lab_market_lines (write-once) + cfb_market_line_corrections
--     quarantine        cfb_market_quote_quarantine (supabase/cfb_market_integrity.sql)
--     decisions, price targets, CLV results, shadow
--                       cfb_decision_snapshots / cfb_decision_results /
--                       cfb_decision_shadow_compare (supabase/cfb_decision.sql)
--   New here:
--     cfb_market_consensus_snapshots   point-in-time consensus per game x moment
--     cfb_market_events                internal alerts (no spam, no mythology)
--     cfb_book_quality                 information weight vs price quality per book
--     cfb_market_predictions           expected close, movement direction, the
--                                      market-informed CHALLENGER margin
--     cfb_market_provider_conflicts    two feeds disagree about one book: both kept
--     cfb_market_information_events    football news vs the market, timing only
--     cfb_market_public_betting        ticket / money splits: experimental, never
--                                      used by a decision (the column is pinned false)
--
-- THE RULES, ENFORCED BY THE SERVER
--   1. Append-only (update / delete / truncate refused, service role included).
--   2. Point in time: a snapshot, prediction or event is made before kickoff.
--   3. Signs: consensus_margin = -median_home_line (home margin; one conversion).
--   4. Measurable language only: an event, a label or a note may not claim
--      "sharp", "steam", "smart money" or a cause; an information event records
--      timing (TIMING_CONSISTENT ...), never CAUSED.
--   5. A CHALLENGER prediction is never labelled pure and never the fair line.
--   6. Public betting data can never enter a decision (decision_use = false).
--   7. Internal: authenticated reads, anon reads nothing.
--
-- DEPENDENCIES: none (the canonical-quote view appears only when
-- cfb_lab_market_quotes exists). CONVENTION (supabase/README.md): idempotent,
-- additive, pasted into the SQL editor, no psql meta-commands, ends in a report.
-- Tested against a real PostgreSQL by football/cfb_market/sql.test.js.
-- =============================================================================

create or replace function public.cfb_market_no_myth(p text)
returns boolean language sql immutable
set search_path = pg_catalog, pg_temp
as $fn$
  select p is null or p !~* '(sharps?[[:space:]]+(are|were|is|on|money|action|bettors?|side|play|hit|loaded)|sharp money|smart money|syndicate|wise[[:space:]]?guys?|steam(ed|ing)?|\mlock\M|free money|guarantee|caused by)'
$fn$;

-- ======================================================== consensus snapshots
create table if not exists public.cfb_market_consensus_snapshots (
  snapshot_id               text primary key,
  rule_version              text not null,
  game_id                   text not null,
  season                    int,
  week                      int,
  as_of                     timestamptz not null,
  kickoff_ts                timestamptz not null,
  n_books_seen              int not null check (n_books_seen >= 0),
  n_active_books            int not null check (n_active_books >= 0),
  stale_book_count          int not null check (stale_book_count >= 0),
  integrity_excluded_count  int not null default 0 check (integrity_excluded_count >= 0),
  median_home_line          numeric(6,2),
  weighted_median_home_line numeric(6,2),
  mean_home_line            numeric(7,3),
  trimmed_mean_home_line    numeric(7,3),
  consensus_margin          numeric(6,2),
  consensus_uncertainty     numeric(6,3) check (consensus_uncertainty is null or consensus_uncertainty >= 0),
  dispersion_iqr            numeric(6,3) check (dispersion_iqr is null or dispersion_iqr >= 0),
  dispersion_sd             numeric(6,3),
  best_home_book            text,
  best_home_line            numeric(6,2),
  best_home_price           int,
  best_away_book            text,
  best_away_line            numeric(6,2),
  best_away_price           int,
  median_price_home         int,
  median_price_away         int,
  integrity_status          text,
  actionable_status         text,
  quote_ids                 text[] not null default '{}',
  payload                   jsonb not null,
  recorded_at               timestamptz not null default now(),
  constraint cfb_mcs_pregame check (as_of < kickoff_ts),
  constraint cfb_mcs_books check (n_active_books + stale_book_count + integrity_excluded_count <= n_books_seen),
  constraint cfb_mcs_sign check (consensus_margin is null or median_home_line is null or consensus_margin = -median_home_line),
  constraint cfb_mcs_needs_books check (median_home_line is null or n_active_books >= 1),
  constraint cfb_mcs_prices check ((best_home_price is null or abs(best_home_price) >= 100) and (best_away_price is null or abs(best_away_price) >= 100)
    and (median_price_home is null or abs(median_price_home) >= 100) and (median_price_away is null or abs(median_price_away) >= 100)),
  constraint cfb_mcs_actionable check (actionable_status is null or actionable_status in ('ACTIONABLE','MARKET_STALE','MARKET_DEGRADED','MARKET_INVALID','MARKET_MISSING')),
  constraint cfb_mcs_integrity check (integrity_status is null or integrity_status in ('OK','DEGRADED','INVALID','MISSING'))
);
create unique index if not exists cfb_market_consensus_snapshots_key on public.cfb_market_consensus_snapshots (game_id, as_of, rule_version);

-- ================================================================== events
create table if not exists public.cfb_market_events (
  event_id     text primary key,
  game_id      text not null,
  event_type   text not null,
  at           timestamptz not null,
  kickoff_ts   timestamptz not null,
  rule_version text not null,
  detail       jsonb not null,
  recorded_at  timestamptz not null default now(),
  constraint cfb_mev_type check (event_type in ('MODEL_EDGE_APPEARS','MODEL_EDGE_DISAPPEARS','STALE_PRICE','MARKET_MOVES_TOWARD_MODEL',
    'MARKET_MOVES_AWAY_FROM_MODEL','KEY_NUMBER_CROSSED','QB_NEWS_REPRICES_MARKET','COORDINATED_MOVE','MARKET_CONTRADICTION','PROVIDER_CONFLICT')),
  constraint cfb_mev_pregame check (at < kickoff_ts),
  constraint cfb_mev_words check (public.cfb_market_no_myth(detail::text))
);
create unique index if not exists cfb_market_events_key on public.cfb_market_events (game_id, event_type, at);

-- ============================================================ book quality
create table if not exists public.cfb_book_quality (
  book_quality_id           text primary key,
  artifact_version          text not null,
  book                      text not null,
  family                    text,
  market_information_weight numeric(6,3) not null check (market_information_weight >= 0),
  consensus_weight          numeric(6,3) not null check (consensus_weight > 0),
  stale_or_outlier_rate     numeric(6,4) check (stale_or_outlier_rate is null or stale_or_outlier_rate between 0 and 1),
  hold                      numeric(6,4) check (hold is null or hold between 0 and 0.3),
  fit_seasons               int[] not null,
  weights_active            boolean not null,
  payload                   jsonb not null,
  recorded_at               timestamptz not null default now(),
  -- information quality is fit on development seasons only (2016-2023)
  constraint cfb_bq_dev_only check (fit_seasons <@ array[2016,2017,2018,2019,2020,2021,2022,2023])
);
create unique index if not exists cfb_book_quality_key on public.cfb_book_quality (artifact_version, book);

-- ============================================================= predictions
create table if not exists public.cfb_market_predictions (
  prediction_id  text primary key,
  game_id        text not null,
  kind           text not null,
  as_of          timestamptz not null,
  kickoff_ts     timestamptz not null,
  model_version  text not null,
  role           text not null,
  value          numeric(8,3),
  uncertainty    numeric(8,3),
  label          text not null,
  payload        jsonb not null,
  recorded_at    timestamptz not null default now(),
  constraint cfb_mp_kind check (kind in ('EXPECTED_CLOSE_MARGIN','MOVEMENT_DIRECTION','MARKET_ADJUSTED_PROJECTION')),
  constraint cfb_mp_role check (role in ('research','challenger')),
  constraint cfb_mp_pregame check (as_of < kickoff_ts),
  -- the market-informed challenger is never the pure model and never the fair line
  constraint cfb_mp_challenger check (kind <> 'MARKET_ADJUSTED_PROJECTION' or (role = 'challenger' and label !~* 'fair line|pure' ))
);
create unique index if not exists cfb_market_predictions_key on public.cfb_market_predictions (game_id, kind, model_version, as_of);

-- ===================================================== provider conflicts
create table if not exists public.cfb_market_provider_conflicts (
  conflict_id     text primary key,
  game_id         text not null,
  book            text not null,
  sources         text[] not null check (cardinality(sources) = 2),
  quote_ids       text[] not null,
  lines           numeric[] not null,
  difference_pts  numeric(6,2) not null check (difference_pts >= 0),
  major           boolean not null,
  likely_fresher  text not null,
  action          text not null default 'PRESERVE_BOTH' check (action = 'PRESERVE_BOTH'),
  detected_at     timestamptz not null,
  recorded_at     timestamptz not null default now()
);

-- ================================================== information events
create table if not exists public.cfb_market_information_events (
  info_event_id   text primary key,
  game_id         text not null,
  event_type      text not null,
  event_at        timestamptz not null,
  market_before   numeric(6,2),
  market_before_at timestamptz,
  market_after    numeric(6,2),
  market_after_at timestamptz,
  move_pts        numeric(6,2),
  attribution     text not null check (attribution in ('TIMING_CONSISTENT','NO_MOVE','MOVED_BEFORE_EVENT','INSUFFICIENT_DATA')),
  detail          jsonb not null,
  recorded_at     timestamptz not null default now(),
  constraint cfb_mie_order check (market_before_at is null or market_before_at <= event_at),
  constraint cfb_mie_after check (market_after_at is null or market_after_at > event_at),
  constraint cfb_mie_words check (public.cfb_market_no_myth(detail::text))
);

-- ================================================ public betting (experimental)
create table if not exists public.cfb_market_public_betting (
  split_id         text primary key,
  game_id          text not null,
  source           text not null,
  observed_at      timestamptz not null,
  ticket_pct_home  numeric(5,2) check (ticket_pct_home is null or ticket_pct_home between 0 and 100),
  money_pct_home   numeric(5,2) check (money_pct_home is null or money_pct_home between 0 and 100),
  coverage         text,
  decision_use     boolean not null default false check (decision_use = false),
  recorded_at      timestamptz not null default now(),
  constraint cfb_mpb_some check (ticket_pct_home is not null or money_pct_home is not null)
);

-- ===================================================== append-only + access
create or replace function public.cfb_market_append_only()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $fn$
begin
  if tg_op = 'UPDATE' then
    raise exception '% is append-only: a market record is never rewritten', tg_table_name using errcode = 'restrict_violation';
  elsif tg_op = 'DELETE' then
    raise exception '% is append-only: rows are never deleted', tg_table_name using errcode = 'restrict_violation';
  else
    raise exception '% is append-only: it is never truncated', tg_table_name using errcode = 'restrict_violation';
  end if;
end $fn$;

do $blk$
declare
  t text;
begin
  foreach t in array array['cfb_market_consensus_snapshots','cfb_market_events','cfb_book_quality','cfb_market_predictions',
    'cfb_market_provider_conflicts','cfb_market_information_events','cfb_market_public_betting']
  loop
    execute format('drop trigger if exists %I on public.%I', t || '_no_update_trg', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.cfb_market_append_only()', t || '_no_update_trg', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_delete_trg', t);
    execute format('create trigger %I before delete on public.%I for each row execute function public.cfb_market_append_only()', t || '_no_delete_trg', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate_trg', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.cfb_market_append_only()', t || '_no_truncate_trg', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_read', t);
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on table public.%I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke insert, update, delete, truncate, references, trigger on table public.%I from authenticated', t);
      execute format('grant select on table public.%I to authenticated', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke update, delete, truncate on table public.%I from service_role', t);
      execute format('grant select, insert on table public.%I to service_role', t);
    end if;
  end loop;
end $blk$;

-- ================================================================== views
-- The Model Lab market panel: per game, the opener (first snapshot), the
-- current snapshot, movement since open, and how many toward/away events.
-- The decision panels (EV, BET NOW / WAIT / PASS, BETTABLE TO, expected CLV,
-- the CLV record) are cfb_decision_lab_view / cfb_decision_scorecard, joined
-- by game_id on the page.
create or replace view public.cfb_market_lab_panel with (security_invoker = true) as
with ranked as (
  select s.*, row_number() over (partition by game_id order by as_of asc) as first_rank,
         row_number() over (partition by game_id order by as_of desc) as last_rank
    from public.cfb_market_consensus_snapshots s
)
select c.game_id, c.kickoff_ts, c.as_of as current_as_of, c.median_home_line as current_home_line, c.consensus_margin as current_margin,
       c.n_active_books, c.stale_book_count, c.dispersion_iqr, c.consensus_uncertainty, c.actionable_status,
       c.best_home_book, c.best_home_line, c.best_home_price, c.best_away_book, c.best_away_line, c.best_away_price,
       o.as_of as open_as_of, o.median_home_line as open_home_line,
       (c.consensus_margin - o.consensus_margin) as movement_since_open,
       (select count(*) from public.cfb_market_events e where e.game_id = c.game_id and e.event_type = 'MARKET_MOVES_TOWARD_MODEL') as moves_toward_model,
       (select count(*) from public.cfb_market_events e where e.game_id = c.game_id and e.event_type = 'MARKET_MOVES_AWAY_FROM_MODEL') as moves_away_from_model
  from ranked c
  join ranked o on o.game_id = c.game_id and o.first_rank = 1
 where c.last_rank = 1;

-- Every Lab quote as the brief's canonical side quotes (HOME MARGIN convention).
do $blk$
begin
  if to_regclass('public.cfb_lab_market_quotes') is not null then
    execute $v$
      create or replace view public.cfb_market_quotes_canonical with (security_invoker = true) as
      select q.quote_id, q.game_id, q.book as sportsbook, q.source, q.market_type, s.side,
             case when q.market_type = 'spread' then (case when s.side = 'HOME' then q.home_line else -q.home_line end)
                  when q.market_type = 'total' then q.total_points end as line,
             case when q.market_type = 'spread' then -q.home_line end as home_market_margin,
             s.price as american_odds,
             case when s.price >= 100 then 1 + s.price / 100.0 when s.price <= -100 then 1 + 100.0 / (-s.price) end as decimal_odds,
             case when s.price >= 100 then 100.0 / (s.price + 100) when s.price <= -100 then (-s.price)::numeric / (-s.price + 100) end as implied_probability_raw,
             q.observed_at as quote_timestamp, q.provider_updated_at as provider_timestamp, q.retrieved_at as received_timestamp,
             q.is_provider_open, q.is_provider_close, q.is_pregame
        from public.cfb_lab_market_quotes q
        cross join lateral (values
          (case when q.market_type = 'total' then 'OVER' else 'HOME' end, case when q.market_type = 'total' then q.price_over else q.price_home end),
          (case when q.market_type = 'total' then 'UNDER' else 'AWAY' end, case when q.market_type = 'total' then q.price_under else q.price_away end)
        ) as s(side, price)
    $v$;
  end if;
end $blk$;
