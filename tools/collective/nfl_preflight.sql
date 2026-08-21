-- Why the NFL model has not produced a Week 1 row yet.
--
-- Paste into the Supabase SQL editor and run. Read-only: it creates nothing,
-- writes nothing, and touches no odds credits.
--
-- Every line of the answer comes out of YOUR database. Nothing here is a
-- guess about what might be missing; each row either found the thing or it
-- did not. Run it again after each fix and watch the blockers turn to ok.
--
-- The three facts it is chasing, in the order the model hits them:
--
--   1. public.nfl_team_features   -- the model refuses to run without it
--   2. public.signals             -- the games it would predict on
--   3. public.model_predictions   -- what it has already written
--
-- models/nfl.ts says so itself, at the top of the file:
--
--     STATUS ON TODAY'S DATABASE: insufficient_data.
--     EdgeDesk owns no NFL efficiency table. The model below is complete and
--     tested, and it runs the moment public.nfl_team_features is populated.
--     Until then it writes nothing and reports exactly which columns are
--     missing. That is deliberate: a fabricated 57.3% in the historical
--     record is worse than a gap in it.

create or replace function pg_temp.nfl_preflight()
returns table (step text, verdict text, detail text)
language plpgsql
as $fn$
declare
  n           bigint;
  cols        text[];
  want        text[] := array['off_epa_play','def_epa_play','plays_per_game'];
  missing     text[];
  ahead_hours numeric;
  inside      bigint;
  furthest    timestamptz;
begin
  ------------------------------------------------------------------ features
  if to_regclass('public.nfl_team_features') is null then
    return query select
      'nfl_team_features'::text,
      'BLOCKED'::text,
      ('table does not exist. The model needs ' || array_to_string(want, ', ')
       || ' per team before it will produce a single row.')::text;
  else
    select array_agg(column_name::text)
      into cols
      from information_schema.columns
     where table_schema = 'public' and table_name = 'nfl_team_features';

    select array_agg(w) into missing
      from unnest(want) w
     where not (w = any(coalesce(cols, '{}'::text[])));

    execute 'select count(*) from public.nfl_team_features' into n;

    if missing is not null then
      return query select
        'nfl_team_features'::text, 'BLOCKED'::text,
        ('table exists with ' || n || ' rows, but these columns are missing: '
         || array_to_string(missing, ', '))::text;
    elsif n = 0 then
      return query select
        'nfl_team_features'::text, 'BLOCKED'::text,
        'all three columns exist but the table is empty. 32 rows are needed, one per team.'::text;
    else
      return query select
        'nfl_team_features'::text, 'ok'::text,
        (n || ' row' || case when n = 1 then '' else 's' end
         || ', all required columns present')::text;
    end if;
  end if;

  ---------------------------------------------------------- points fallback
  -- The model has a second, weaker path off raw points. NFL_CONTRACT says of
  -- these columns "not present today", so this check exists to tell you
  -- whether that has changed, not to recommend the fallback: it is flagged
  -- LOW quality on every row it produces.
  if to_regclass('public.game_stats') is null then
    return query select
      'game_stats (fallback)'::text, 'unavailable'::text,
      'table does not exist. Not a problem on its own; it is the weaker of the two paths.'::text;
  else
    select array_agg(column_name::text) into cols
      from information_schema.columns
     where table_schema = 'public' and table_name = 'game_stats'
       and column_name in ('points_for','points_against','games');
    return query select
      'game_stats (fallback)'::text,
      case when coalesce(array_length(cols,1),0) = 3 then 'available' else 'unavailable' end::text,
      ('points_for / points_against / games present: '
       || coalesce(array_to_string(cols, ', '), 'none'))::text;
  end if;

  ------------------------------------------------------------------ signals
  -- The model predicts on captured market events, not on a schedule table.
  -- No signals row for a game means no prediction for that game, however
  -- complete the features are.
  if to_regclass('public.signals') is null then
    return query select 'signals'::text, 'BLOCKED'::text,
      'table does not exist; the model has no event universe to predict on.'::text;
  else
    execute $q$
      select count(distinct event_id), max(commence_time)
        from public.signals
       where sport_key like 'americanfootball_nfl%'
         and commence_time >= now()
    $q$ into n, furthest;

    if n = 0 then
      return query select 'signals (NFL, upcoming)'::text, 'BLOCKED'::text,
        'no upcoming NFL events captured. The Collective feed writes to the odds schema; this model reads public.signals.'::text;
    else
      return query select 'signals (NFL, upcoming)'::text, 'ok'::text,
        (n || ' events, furthest kickoff ' || to_char(furthest at time zone 'America/New_York','YYYY-MM-DD'))::text;
    end if;

    -- NFL_WINDOW_AHEAD_H defaults to 192 hours = 8 days. Week 1 is further
    -- out than that from today, so the model would look straight past it
    -- even with a fully populated features table. This is a one-line env
    -- change, but it is invisible: the run reports success and zero rows.
    ahead_hours := 192;
    execute $q$
      select count(*) filter (where commence_time <= now() + ($1 || ' hours')::interval),
             count(*)
        from public.signals
       where sport_key like 'americanfootball_nfl%'
         and commence_time >= now()
    $q$ into inside, n using ahead_hours::text;

    return query select
      'model window (NFL_WINDOW_AHEAD_H)'::text,
      case when inside = 0 then 'BLOCKED'
           when inside < n then 'PARTIAL'
           else 'ok' end::text,
      (inside || ' of ' || n || ' captured NFL events fall inside the default '
       || ahead_hours || 'h look-ahead'
       || case when inside < n
               then '. The other ' || (n - inside) || ' are further out and get '
                    || 'skipped in silence: the run reports success and simply '
                    || 'does not mention them. Raise NFL_WINDOW_AHEAD_H to reach '
                    || 'the slate you want.'
               else '.' end)::text;
  end if;

  -------------------------------------------------------------- predictions
  if to_regclass('public.model_predictions') is null then
    return query select 'model_predictions'::text, 'BLOCKED'::text,
      'table does not exist.'::text;
  else
    execute $q$
      select count(*) from public.model_predictions
       where model_version = 'nfl_game_v1'
    $q$ into n;
    return query select
      'model_predictions (nfl_game_v1)'::text,
      case when n > 0 then 'ok' else 'empty' end::text,
      (n || ' rows written by the NFL model, all time. '
       || 'model_to_csv.sql exports from here, so it returns nothing until this is non-zero.')::text;
  end if;
end
$fn$;

select * from pg_temp.nfl_preflight();

-- The one command that makes the model itself answer, read-only, writing
-- nothing. It reports the same blockers in the model's own words, plus the
-- exact missing_features list per event:
--
--   curl "https://<project>.supabase.co/functions/v1/model_predict?dry=1&sport=NFL"
