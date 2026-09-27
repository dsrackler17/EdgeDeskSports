-- cfb_market_integrity -- part 1 of 2.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- =============================================================================
-- cfb_market_integrity — the Postgres half of the CFB market, settlement and
-- admin integrity rules (docs/cfb-production/MARKET_INTEGRITY.md,
-- SETTLEMENT.md, SECURITY.md).
--
-- WHAT IT ADDS (nothing here edits or replaces an object of cfb_lab.sql)
--   1. cfb_market_quote_quarantine   quotes refused (REJECT: impossible values,
--      clock faults) or quarantined (QUARANTINE: outliers, sign flips) by the
--      integrity rules. Append-only: kept for investigation, never deleted,
--      never part of any opener, close or consensus. The repository ledger's
--      quarantine.jsonl has the same columns.
--   2. cfb_market_quote_problems(q, now)  the hard quote rules
--      (cfb_market_quote_integrity_v1), the same codes as
--      football/cfb_lab/integrity.js validateQuote and the capture function's
--      cfbQuoteProblems; football/cfb_lab/fixtures/integrity_rules.json holds
--      the cases all three must reproduce.
--   3. cfb_market_quarantine_quotes(p_quotes)  the capture function's
--      quarantine RPC (fail-soft on its side).
--      cfb_market_ingest_quotes(p_quotes)      the CHECKED ingest: bad quotes to
--      the quarantine, the rest forwarded unchanged to cfb_lab_ingest_quotes().
--   4. cfb_market_line_corrections  audited corrections to a derived opener or
--      close ("opener corrected version"); the original line is never touched.
--   5. Settlement safety: a FINAL result needs two scores in 0..150 that are not
--      tied (college football has no ties), enforced BEFORE INSERT on
--      cfb_lab_results; and one evaluation per (prediction, eval version,
--      result, close line) — a wager is never graded twice.
--   6. cfb_market_admin_set_role(...)  the guarded way to change a model role:
--      an explicit, retyped model version, a registered model, a reason, an
--      actor, and no direct retirement of the champion.
--   7. cfb_market_bet_volume  weekly official BET counts against their history
--      (a flag asks for review; it never cancels a bet).
--
-- DEPENDENCIES: supabase/cfb_lab.sql (cfb_lab_h, cfb_lab_ts, cfb_lab_num,
-- cfb_lab_try_ts, cfb_lab_append_only, cfb_lab_ingest_quotes, cfb_lab_set_role
-- and the cfb_lab_ tables). Apply it after cfb_lab.sql.
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again. Tested
-- against a real PostgreSQL by football/cfb_lab/integrity_sql.test.js.
-- =============================================================================

-- ------------------------------------------------------------- 1. tables
create table if not exists public.cfb_market_quote_quarantine (
  quarantine_id        text primary key,
  stage                text not null,
  severity             text not null,
  reasons              text[] not null,
  rule_version         text not null,
  quote_id             text,
  source               text,
  book                 text,
  game_id              text,
  provider_event_id    text,
  market_type          text,
  season               int,
  week                 int,
  home_line            numeric,
  total_points         numeric,
  price_home           numeric,
  price_away           numeric,
  price_over           numeric,
  price_under          numeric,
  observed_at          timestamptz,
  provider_updated_at  timestamptz,
  kickoff_ts           timestamptz,
  is_pregame           boolean,
  is_provider_open     boolean,
  is_provider_close    boolean,
  home_team            text,
  away_team            text,
  evidence             jsonb,
  raw                  jsonb,
  detected_at          timestamptz not null,
  recorded_at          timestamptz not null default now(),
  constraint cfb_mq_id_format check (quarantine_id ~ '^cfbz_[0-9a-f]{24}$'),
  constraint cfb_mq_stage check (stage in ('INGEST','CONSENSUS')),
  constraint cfb_mq_severity check (severity in ('REJECT','QUARANTINE')),
  constraint cfb_mq_reasons check (cardinality(reasons) >= 1)
);
comment on table public.cfb_market_quote_quarantine is
  'Quotes refused or quarantined by the CFB market integrity rules (docs/cfb-production/MARKET_INTEGRITY.md). Append-only: kept for investigation, never deleted, never used in a consensus.';
create index if not exists cfb_mq_game_idx on public.cfb_market_quote_quarantine (game_id, market_type, observed_at);
create index if not exists cfb_mq_detected_idx on public.cfb_market_quote_quarantine (detected_at);

create table if not exists public.cfb_market_line_corrections (
  correction_id  text primary key,
  line_id        text not null,
  game_id        text not null,
  kind           text not null,
  book           text not null,
  market_type    text not null,
  version        int not null,
  original       jsonb not null,
  corrected      jsonb not null,
  reason         text not null,
  actor          text not null,
  created_at     timestamptz not null,
  recorded_at    timestamptz not null default now(),
  constraint cfb_mlc_id_format check (correction_id ~ '^cfbk_[0-9a-f]{24}$'),
  constraint cfb_mlc_kind check (kind in ('OPEN','CLOSE')),
  constraint cfb_mlc_reason check (length(btrim(reason)) >= 10),
  constraint cfb_mlc_actor check (length(btrim(actor)) >= 2),
  constraint cfb_mlc_version check (version >= 1)
);
comment on table public.cfb_market_line_corrections is
  'Audited corrections to a derived opener/close. The original cfb_lab_market_lines row is never edited; grading keeps using it.';

-- -------------------------------------------------- 2. the hard quote rules
-- A value is a number only when it IS one: JSON null, "", booleans and
-- non-numeric text are NOT 0 (the missing-field-to-zero bug).
create or replace function public.cfb_market_strict_num(v jsonb)
returns numeric language plpgsql immutable
set search_path = pg_catalog, pg_temp
as $fn$
begin
  if v is null or jsonb_typeof(v) = 'null' then return null; end if;
  if jsonb_typeof(v) = 'number' then return (v #>> '{}')::numeric; end if;
  if jsonb_typeof(v) = 'string' and btrim(v #>> '{}') ~ '^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)$' then
    return btrim(v #>> '{}')::numeric;
  end if;
  return null;
exception when others then
  return null;
end $fn$;

create or replace function public.cfb_market_implied(a numeric)
returns float8 language sql immutable
set search_path = pg_catalog, pg_temp
as $fn$
  select case when a is null or abs(a) < 100 then null
              when a > 0 then 100::float8 / (a::float8 + 100::float8)
              else (-a)::float8 / ((-a)::float8 + 100::float8) end
$fn$;

-- cfb_market_quote_integrity_v1: the value and clock rules (the wrong-game
-- rules need the game index and run in the lab job). Returns the reasons,
-- empty = the quote is possible. Codes = integrity.js validateQuote.
create or replace function public.cfb_market_quote_problems(q jsonb, p_now timestamptz default now())
returns text[] language plpgsql stable
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_out   text[] := '{}';
  v_mt    text := q ->> 'market_type';
  v_col   text;
  v_a     numeric;
  v_hl    numeric := public.cfb_market_strict_num(q -> 'home_line');
  v_tp    numeric := public.cfb_market_strict_num(q -> 'total_points');
  v_cols  text[] := case when q ->> 'market_type' = 'total' then array['price_over','price_under'] else array['price_home','price_away'] end;
  v_max   numeric := case when q ->> 'market_type' = 'moneyline' then 100000 else 1000 end;
  v_p1    float8;
  v_p2    float8;
  v_obs   timestamptz := public.cfb_lab_try_ts(q ->> 'observed_at');
  v_upd   timestamptz := public.cfb_lab_try_ts(q ->> 'provider_updated_at');
begin
  if q is null or jsonb_typeof(q) <> 'object' then return array['NOT_AN_OBJECT']; end if;
  foreach v_col in array array['home_line','total_points','price_home','price_away','price_over','price_under'] loop
    if q ? v_col and jsonb_typeof(q -> v_col) <> 'null' and coalesce(q ->> v_col, '') <> ''
       and public.cfb_market_strict_num(q -> v_col) is null then
      v_out := v_out || ('NON_NUMERIC_' || upper(v_col));
    end if;
  end loop;
  if v_mt = 'spread' and v_hl is not null and abs(v_hl) > 70 then v_out := v_out || 'SPREAD_OUT_OF_BOUNDS'::text; end if;
  if v_mt = 'total' and v_tp is not null and (v_tp < 20 or v_tp > 100) then v_out := v_out || 'TOTAL_OUT_OF_BOUNDS'::text; end if;
  foreach v_col in array v_cols loop
    v_a := public.cfb_market_strict_num(q -> v_col);
    continue when v_a is null;
    if v_a = 0 then v_out := v_out || 'PRICE_ZERO'::text;
    elsif abs(v_a) < 100 then v_out := v_out || 'PRICE_NOT_AMERICAN'::text;
    elsif abs(v_a) > v_max then v_out := v_out || 'PRICE_OUT_OF_BOUNDS'::text;
    elsif round(v_a) <> v_a then v_out := v_out || 'PRICE_NOT_INTEGER'::text;
    end if;
  end loop;
  v_p1 := public.cfb_market_implied(public.cfb_market_strict_num(q -> v_cols[1]));
  v_p2 := public.cfb_market_implied(public.cfb_market_strict_num(q -> v_cols[2]));
  if v_p1 is not null and v_p2 is not null then
    if public.cfb_market_strict_num(q -> v_cols[1]) = public.cfb_market_strict_num(q -> v_cols[2]) and v_p1 + v_p2 > 1.30 then
      v_out := v_out || 'IDENTICAL_SIDE_PRICES'::text;
    elsif v_p1 + v_p2 > 1.30 then v_out := v_out || 'TWO_WAY_HOLD_TOO_HIGH'::text;
    end if;
    if v_p1 + v_p2 < 0.99 then v_out := v_out || 'TWO_WAY_BELOW_FAIR'::text; end if;
  end if;
  if v_obs is not null and p_now is not null and v_obs > p_now + interval '5 minutes' then v_out := v_out || 'OBSERVED_IN_FUTURE'::text; end if;
  if v_upd is not null and v_obs is not null and v_upd > v_obs + interval '5 minutes' then v_out := v_out || 'PROVIDER_TS_AFTER_OBSERVED'::text; end if;
  if coalesce(q ->> 'provider_updated_at', '') <> '' and v_upd is null then v_out := v_out || 'PROVIDER_TS_UNPARSEABLE'::text; end if;
  return (select coalesce(array_agg(x order by o), '{}') from (select distinct on (x) x, o from unnest(v_out) with ordinality as u(x, o) order by x, o) d);
end $fn$;

-- the quote id cfb_lab_ingest_quotes would give this quote (event map first)
create or replace function public.cfb_market_quote_id(q jsonb)
returns text language plpgsql stable
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_game text := nullif(q ->> 'game_id', '');
  v_key  text;
  v_obs  timestamptz := public.cfb_lab_try_ts(q ->> 'observed_at');
begin
  if v_game is null and nullif(q ->> 'provider_event_id', '') is not null then
    select m.game_id into v_game from public.cfb_lab_event_map m
     where m.source = q ->> 'source' and m.provider_event_id = q ->> 'provider_event_id'
     order by m.created_at desc, m.recorded_at desc, m.map_id desc limit 1;
  end if;
  v_key := coalesce(v_game, nullif(q ->> 'provider_event_id', ''));
  return 'cfbq_' || case
    when coalesce((q ->> 'is_provider_open')::boolean, false) then public.cfb_lab_h(q ->> 'source', q ->> 'book', v_key, q ->> 'market_type', public.cfb_lab_ts(v_obs), 'provider_open')
    when coalesce((q ->> 'is_provider_close')::boolean, false) then public.cfb_lab_h(q ->> 'source', q ->> 'book', v_key, q ->> 'market_type', public.cfb_lab_ts(v_obs), 'provider_close')
    else public.cfb_lab_h(q ->> 'source', q ->> 'book', v_key, q ->> 'market_type', public.cfb_lab_ts(v_obs)) end;
exception when others then
  return 'cfbq_' || public.cfb_lab_h('unreadable', md5(q::text));
end $fn$;

-- ------------------------------------------ 3. quarantine and checked ingest
-- p_quotes: a JSON array of quote objects (the capture feed's shape), each
-- optionally carrying "reasons" (the caller's own verdict). The stored reasons
-- are the caller's and this file's, together; a quote with neither is not
-- quarantined (counted as clean). One row per (quote, stage): a replay is a
-- no-op. Returns {received, quarantined, duplicates, clean, rule_version}.
create or replace function public.cfb_market_quarantine_quotes(p_quotes jsonb, p_stage text default 'INGEST', p_now timestamptz default now())
returns jsonb language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  e        record;
  v_given  text[];
  v_found  text[];
  v_all    text[];
  v_qid    text;
  v_id     text;
  v_n      int;
  v_recv   int := 0;
  v_q      int := 0;
  v_dup    int := 0;
  v_clean  int := 0;
  v_sev    text;
begin
  if p_quotes is null or jsonb_typeof(p_quotes) <> 'array' then
    raise exception 'cfb_market_quarantine_quotes: p_quotes must be a JSON array' using errcode = 'invalid_parameter_value';
  end if;
  if p_stage not in ('INGEST','CONSENSUS') then
    raise exception 'cfb_market_quarantine_quotes: stage must be INGEST or CONSENSUS' using errcode = 'invalid_parameter_value';
  end if;
  for e in select value as j from jsonb_array_elements(p_quotes) loop
    v_recv := v_recv + 1;
    v_given := case when jsonb_typeof(e.j -> 'reasons') = 'array'
                    then array(select jsonb_array_elements_text(e.j -> 'reasons') where true) else '{}' end;
    v_found := public.cfb_market_quote_problems(e.j, p_now);
    v_all := array(select distinct x from unnest(v_given || v_found) x where x ~ '^[A-Z_]{3,64}$' order by x);
    if cardinality(v_all) = 0 then v_clean := v_clean + 1; continue; end if;
    v_sev := case when cardinality(v_found) > 0 or exists (select 1 from unnest(v_all) x where x in
      ('SPREAD_OUT_OF_BOUNDS','TOTAL_OUT_OF_BOUNDS','PRICE_ZERO','PRICE_NOT_AMERICAN','PRICE_OUT_OF_BOUNDS','PRICE_NOT_INTEGER',
       'IDENTICAL_SIDE_PRICES','TWO_WAY_HOLD_TOO_HIGH','TWO_WAY_BELOW_FAIR','OBSERVED_IN_FUTURE','PROVIDER_TS_AFTER_OBSERVED',
       'PROVIDER_TS_UNPARSEABLE','WRONG_GAME_TEAMS','WRONG_GAME_ORIENTATION','WRONG_GAME_KICKOFF')
       or x like 'NON_NUMERIC_%') then 'REJECT' else 'QUARANTINE' end;
    v_qid := coalesce(nullif(e.j ->> 'quote_id', ''), public.cfb_market_quote_id(e.j));
    v_id := 'cfbz_' || public.cfb_lab_h(v_qid, p_stage);
    insert into public.cfb_market_quote_quarantine (quarantine_id, stage, severity, reasons, rule_version, quote_id, source, book, game_id,
      provider_event_id, market_type, season, week, home_line, total_points, price_home, price_away, price_over, price_under,
      observed_at, provider_updated_at, kickoff_ts, is_pregame, is_provider_open, is_provider_close, home_team, away_team, evidence, raw, detected_at)
    values (v_id, p_stage, v_sev, v_all, coalesce(nullif(e.j ->> 'rule_version', ''), 'cfb_market_quote_integrity_v1'), v_qid,
      e.j ->> 'source', e.j ->> 'book', nullif(e.j ->> 'game_id', ''), nullif(e.j ->> 'provider_event_id', ''), e.j ->> 'market_type',
      case when (e.j ->> 'season') ~ '^[0-9]{4}$' then (e.j ->> 'season')::int end,
      case when (e.j ->> 'week') ~ '^[0-9]{1,2}$' then (e.j ->> 'week')::int end,
      public.cfb_market_strict_num(e.j -> 'home_line'), public.cfb_market_strict_num(e.j -> 'total_points'),
      public.cfb_market_strict_num(e.j -> 'price_home'), public.cfb_market_strict_num(e.j -> 'price_away'),
      public.cfb_market_strict_num(e.j -> 'price_over'), public.cfb_market_strict_num(e.j -> 'price_under'),
      public.cfb_lab_try_ts(e.j ->> 'observed_at'), public.cfb_lab_try_ts(e.j ->> 'provider_updated_at'), public.cfb_lab_try_ts(e.j ->> 'kickoff_ts'),
      case when e.j ? 'is_pregame' then (e.j ->> 'is_pregame')::boolean end,
      case when e.j ? 'is_provider_open' then (e.j ->> 'is_provider_open')::boolean end,
      case when e.j ? 'is_provider_close' then (e.j ->> 'is_provider_close')::boolean end,
      e.j ->> 'home_team', e.j ->> 'away_team', case when jsonb_typeof(e.j -> 'evidence') = 'object' then e.j -> 'evidence' end,
      e.j, coalesce(public.cfb_lab_try_ts(e.j ->> 'detected_at'), p_now))
    on conflict (quarantine_id) do nothing;
    get diagnostics v_n = row_count;
    if v_n = 1 then v_q := v_q + 1; else v_dup := v_dup + 1; end if;
  end loop;
  return jsonb_build_object('received', v_recv, 'quarantined', v_q, 'duplicates', v_dup, 'clean', v_clean, 'rule_version', 'cfb_market_quote_integrity_v1');
end $fn$;

-- The checked ingest: the same input as cfb_lab_ingest_quotes. A quote that
-- fails the hard rules goes to the quarantine and is NOT forwarded; the rest
-- are passed to cfb_lab_ingest_quotes unchanged (its own refusals and
-- de-duplication still apply). Returns {received, quarantined, forwarded, lab}.
create or replace function public.cfb_market_ingest_quotes(p_quotes jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_good jsonb := '[]'::jsonb;
  v_bad  jsonb := '[]'::jsonb;
  e      record;
  v_p    text[];
  v_q    jsonb;
  v_lab  jsonb := null;
begin
  if p_quotes is null or jsonb_typeof(p_quotes) <> 'array' then
    raise exception 'cfb_market_ingest_quotes: p_quotes must be a JSON array' using errcode = 'invalid_parameter_value';
  end if;
  for e in select value as j from jsonb_array_elements(p_quotes) loop
    v_p := public.cfb_market_quote_problems(e.j, now());
    if cardinality(v_p) > 0 then v_bad := v_bad || jsonb_build_array(e.j || jsonb_build_object('reasons', to_jsonb(v_p)));
    else v_good := v_good || jsonb_build_array(e.j); end if;
  end loop;
  if jsonb_array_length(v_bad) > 0 then v_q := public.cfb_market_quarantine_quotes(v_bad, 'INGEST', now()); end if;
  if jsonb_array_length(v_good) > 0 then v_lab := public.cfb_lab_ingest_quotes(v_good); end if;
  return jsonb_build_object('received', jsonb_array_length(p_quotes), 'quarantined', jsonb_array_length(v_bad),
    'forwarded', jsonb_array_length(v_good), 'quarantine', v_q, 'lab', v_lab);
end $fn$;
