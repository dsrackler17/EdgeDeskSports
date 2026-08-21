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
  ahead_hours  numeric;
  inside       bigint;
  nearest      timestamptz;
  need_nearest numeric;
  need_all     numeric;
  detail_txt   text;
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
    -- Both counts are DISTINCT EVENTS. Counting rows here while the check
    -- above counts events reads as "0 of 2950" against "272 events", which
    -- looks like two different bugs instead of one number.
    ahead_hours := 192;
    execute $q$
      select count(distinct event_id)
               filter (where commence_time <= now() + ($1 || ' hours')::interval),
             count(distinct event_id),
             min(commence_time)
        from public.signals
       where sport_key like 'americanfootball_nfl%'
         and commence_time >= now()
    $q$ into inside, n, nearest using ahead_hours::text;

    need_nearest := ceil(extract(epoch from (nearest  - now())) / 3600.0);
    need_all     := ceil(extract(epoch from (furthest - now())) / 3600.0);

    return query select
      'model window (NFL_WINDOW_AHEAD_H)'::text,
      case when inside = 0 then 'BLOCKED'
           when inside < n then 'PARTIAL'
           else 'ok' end::text,
      (inside || ' of ' || n || ' captured NFL events fall inside the default '
       || ahead_hours || 'h look-ahead'
       || case
            when inside = 0 then
              '. NOTHING is reachable: the nearest kickoff is '
              || need_nearest || 'h away. A run right now would report success '
              || 'and write zero rows without mentioning a single game. '
              || 'NFL_WINDOW_AHEAD_H needs at least ' || need_nearest
              || ' to reach the first one, or ' || need_all
              || ' to reach every game captured.'
            when inside < n then
              '. The other ' || (n - inside) || ' are further out and get '
              || 'skipped in silence. NFL_WINDOW_AHEAD_H needs ' || need_all
              || ' to reach every game captured.'
            else '.'
          end)::text;
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

    -- The exporter's inputs. This table does not have the same shape in
    -- every project: the live one has no model_detail, and an export that
    -- names a missing column dies outright instead of leaving it blank.
    select array_agg(column_name::text) into cols
      from information_schema.columns
     where table_schema = 'public' and table_name = 'model_predictions';
    cols := coalesce(cols, '{}'::text[]);

    select array_agg(w) into missing
      from unnest(array['event_id','commence_time','home_team','away_team',
                        'market','selection','point','model_prob','model_version']) w
     where not (w = any(cols));

    return query select
      'model_predictions columns (required)'::text,
      case when missing is null then 'ok' else 'BLOCKED' end::text,
      case when missing is null
           then 'every column the export needs for a pick is present'
           else 'the export cannot build a pick without: '
                || array_to_string(missing, ', ') end::text;

    select array_agg(w) into missing
      from unnest(array['model_detail','model_edge','model_ev',
                        'market_prob_at_pred','best_am_at_pred']) w
     where not (w = any(cols));

    return query select
      'model_predictions columns (optional)'::text,
      case when missing is null then 'ok' else 'PARTIAL' end::text,
      case when missing is null
           then 'the projected spread, total, scores and edge columns will all be filled'
           else 'absent, so those CSV columns come out blank: '
                || array_to_string(missing, ', ')
                || case when 'model_detail' = any(missing)
                        then '. model_detail is where the projected spread, total and '
                             || 'scores live, so those four columns will be empty. The '
                             || 'pick, the market line and the probabilities are '
                             || 'unaffected.'
                        else '' end end::text;

    -- What IS writing to this table. If model_predict sends a column the
    -- table does not have, PostgREST rejects the whole insert, so an empty
    -- table plus a missing optional column is worth telling apart from an
    -- empty table on a model that has simply never been triggered.
    if 'model_version' = any(cols) then
      execute $q$
        select string_agg(v || ' (' || c || ')', ', ' order by c desc)
          from (select model_version v, count(*) c
                  from public.model_predictions
                 group by 1 order by 2 desc limit 8) s
      $q$ into detail_txt;
      return query select
        'model_predictions (all models)'::text,
        case when detail_txt is null then 'empty' else 'ok' end::text,
        coalesce(detail_txt,
          'the table is empty for every sport. If other models are supposed to '
          || 'be writing, check that model_predict is not sending a column this '
          || 'table does not have -- PostgREST rejects the whole insert for one '
          || 'unknown column.')::text;
    end if;
  end if;
end
$fn$;

select * from pg_temp.nfl_preflight();

-- The one command that makes the model itself answer, read-only, writing
-- nothing. It reports the same blockers in the model's own words, plus the
-- exact missing_features list per event:
--
--   curl "https://<project>.supabase.co/functions/v1/model_predict?dry=1&sport=NFL"
