-- ============================================================================
-- ufc-pipeline-verify.sql — READ-ONLY diagnosis of the UFC research pipeline.
--
-- Run in the Supabase SQL editor (or psql) against the project the app reads.
-- It writes nothing. Every section prints what it found; nothing is asserted
-- that is not measured.
--
-- Read the sections in order — each one rules out a different cause of the
-- symptoms on the UFC Research screen (no build time, missing fields, empty
-- stat rows, a card that will not appear).
-- ============================================================================


-- ── 1. What actually exists in the ufc schema ───────────────────────────────
-- If a table the app reads is missing here, the app gets a 404/406 and shows
-- its "schema unreachable" state. That is the first thing to rule out.
select c.relkind as kind,          -- r=table  v=view  m=matview
       c.relname as object,
       case when c.relkind = 'r'
            then (select n_live_tup from pg_stat_user_tables s
                   where s.relid = c.oid)
       end      as approx_rows,
       pg_size_pretty(pg_total_relation_size(c.oid)) as size
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'ufc'
   and c.relkind in ('r','v','m')
 order by c.relkind, c.relname;


-- ── 2. Exact row counts for the tables the app reads ────────────────────────
-- approx_rows above comes from the stats collector and drifts. These are real.
-- The app's banner prints the fighter count it received; if that number and
-- this one disagree, the difference is the 20-page × 1000-row fetch cap in
-- ufcFetchAll (20 000 rows), or RLS filtering rows away from the app's role.
select 'fighters'              as table, count(*) from ufc.fighters
union all select 'fighter_fights',         count(*) from ufc.fighter_fights
union all select 'fighter_career_stats',   count(*) from ufc.fighter_career_stats
union all select 'fighter_derived_metrics',count(*) from ufc.fighter_derived_metrics
union all select 'fighter_style_metrics',  count(*) from ufc.fighter_style_metrics
union all select 'live_events',            count(*) from ufc.live_events
union all select 'live_fights',            count(*) from ufc.live_fights
order by 1;


-- ── 3. Does every column the app selects exist? ─────────────────────────────
-- This is the query-shape check. PostgREST rejects the WHOLE select with 400
-- (code 42703) if one column is missing, so a single renamed column takes the
-- entire module dark. Any row printed with exists = f is a live bug.
with app_reads(tbl, col) as (values
  -- loadUFC: fighters
  ('fighters','fighter_id'),('fighters','full_name'),('fighters','nickname'),
  ('fighters','division'),('fighters','stance'),('fighters','height_inches'),
  ('fighters','reach_inches'),('fighters','age'),('fighters','wins'),
  ('fighters','losses'),('fighters','draws'),('fighters','pro_record'),
  -- loadUFC: fighter_derived_metrics
  ('fighter_derived_metrics','fighter_id'),('fighter_derived_metrics','finish_rate'),
  ('fighter_derived_metrics','finish_rate_last5'),('fighter_derived_metrics','win_streak'),
  ('fighter_derived_metrics','loss_streak'),('fighter_derived_metrics','days_since_last_fight'),
  ('fighter_derived_metrics','activity_last365'),('fighter_derived_metrics','title_fight_experience'),
  ('fighter_derived_metrics','average_opponent_reach'),('fighter_derived_metrics','average_opponent_age'),
  ('fighter_derived_metrics','average_round_finished'),('fighter_derived_metrics','average_fight_time'),
  ('fighter_derived_metrics','opponent_average_win_pct'),
  -- loadUFC: fighter_career_stats
  ('fighter_career_stats','fighter_id'),('fighter_career_stats','slpm'),
  ('fighter_career_stats','sapm'),('fighter_career_stats','striking_accuracy'),
  ('fighter_career_stats','striking_defense'),('fighter_career_stats','takedown_avg'),
  ('fighter_career_stats','takedown_accuracy'),('fighter_career_stats','takedown_defense'),
  ('fighter_career_stats','submission_avg'),('fighter_career_stats','knockdown_avg'),
  ('fighter_career_stats','control_time_avg'),
  -- loadUFC: fighter_style_metrics
  ('fighter_style_metrics','fighter_id'),('fighter_style_metrics','primary_style'),
  ('fighter_style_metrics','distance_striker'),('fighter_style_metrics','pressure_striker'),
  ('fighter_style_metrics','counter_striker'),('fighter_style_metrics','wrestler'),
  ('fighter_style_metrics','submission_specialist'),('fighter_style_metrics','grappler'),
  ('fighter_style_metrics','high_output'),('fighter_style_metrics','power_striker'),
  ('fighter_style_metrics','durability_score'),('fighter_style_metrics','finisher'),
  -- ufcLoadFights
  ('fighter_fights','fighter_id'),('fighter_fights','opponent_id'),('fighter_fights','date'),
  ('fighter_fights','weight_class'),('fighter_fights','winner'),('fighter_fights','method'),
  ('fighter_fights','round'),('fighter_fights','time'),('fighter_fights','odds_close'),
  ('fighter_fights','closing_probability'),('fighter_fights','went_distance'),
  ('fighter_fights','title_fight'),
  -- loadUFCLive
  ('live_events','event_id'),('live_events','name'),('live_events','status'),
  ('live_events','start_time'),('live_events','updated_at'),
  ('live_fights','fight_id'),('live_fights','event_id'),('live_fights','red_name'),
  ('live_fights','blue_name'),('live_fights','red_fighter_id'),('live_fights','blue_fighter_id'),
  ('live_fights','status'),('live_fights','round'),('live_fights','clock'),
  ('live_fights','red_strikes'),('live_fights','blue_strikes'),('live_fights','red_td'),
  ('live_fights','blue_td'),('live_fights','red_kd'),('live_fights','blue_kd'),
  ('live_fights','red_win_prob'),('live_fights','weight_class'),('live_fights','is_main'),
  ('live_fights','red_odds'),('live_fights','blue_odds'),
  -- freshness (migration 022)
  ('meta','key'),('meta','value')
)
select a.tbl, a.col,
       (c.column_name is not null) as exists,
       c.data_type
  from app_reads a
  left join information_schema.columns c
    on c.table_schema = 'ufc' and c.table_name = a.tbl and c.column_name = a.col
 where c.column_name is null            -- ← comment this line out to list ALL reads
 order by a.tbl, a.col;


-- ── 4. The four source fields the app does not read ─────────────────────────
-- The field dictionary in the app now PROBES these at runtime. This is the
-- same question asked directly: is the column in the database at all?
--   present → the pipeline loaded it, the app just never selects it (cheap fix)
--   absent  → the sync never loaded it (fix belongs in the sync job)
with wanted(source_field, tbl, col) as (values
  ('dob',        'fighters',             'dob'),
  ('record_nc',  'fighters',             'no_contests'),
  ('knockdowns', 'fighter_career_stats', 'knockdowns'),
  ('fight_time', 'fighter_career_stats', 'total_fight_time')
)
select w.source_field, w.tbl || '.' || w.col as looked_for,
       case when c.column_name is null then 'ABSENT from the database'
            else 'present — in the database, not read by the app' end as verdict
  from wanted w
  left join information_schema.columns c
    on c.table_schema = 'ufc' and c.table_name = w.tbl and c.column_name = w.col
 order by w.source_field;

-- If a column above is ABSENT, check whether the sync stored it under another
-- name before adding it: this lists every column those two tables DO carry.
select table_name, string_agg(column_name, ', ' order by column_name) as columns
  from information_schema.columns
 where table_schema = 'ufc'
   and table_name in ('fighters','fighter_career_stats')
 group by table_name;


-- ── 5. How much of what the app reads is actually populated ─────────────────
-- "The stat rows are blank" is a different bug from "the table is missing".
-- A high null rate means the sync ran but did not fill the column.
select 'fighters.age'                     as column, count(*) filter (where age is null)             as nulls, count(*) as rows from ufc.fighters
union all select 'fighters.reach_inches',       count(*) filter (where reach_inches is null),        count(*) from ufc.fighters
union all select 'fighters.division',           count(*) filter (where division is null),            count(*) from ufc.fighters
union all select 'fighters.pro_record',         count(*) filter (where pro_record is null),          count(*) from ufc.fighters
union all select 'career.slpm',                 count(*) filter (where slpm is null),                count(*) from ufc.fighter_career_stats
union all select 'career.control_time_avg',     count(*) filter (where control_time_avg is null),    count(*) from ufc.fighter_career_stats
union all select 'career.knockdown_avg',        count(*) filter (where knockdown_avg is null),       count(*) from ufc.fighter_career_stats
union all select 'derived.finish_rate',         count(*) filter (where finish_rate is null),         count(*) from ufc.fighter_derived_metrics
union all select 'derived.average_fight_time',  count(*) filter (where average_fight_time is null),  count(*) from ufc.fighter_derived_metrics
union all select 'derived.activity_last365',    count(*) filter (where activity_last365 is null),    count(*) from ufc.fighter_derived_metrics
union all select 'fights.odds_close',           count(*) filter (where odds_close is null),          count(*) from ufc.fighter_fights
union all select 'fights.method',               count(*) filter (where method is null),              count(*) from ufc.fighter_fights
order by 1;

-- Join coverage: a fighter with no derived/career row renders "no DB history".
select count(*)                                                            as fighters,
       count(*) filter (where d.fighter_id is not null)                    as with_derived,
       count(*) filter (where c.fighter_id is not null)                    as with_career,
       count(*) filter (where s.fighter_id is not null)                    as with_style,
       count(*) filter (where f.fighter_id is not null)                    as with_any_fight
  from ufc.fighters x
  left join ufc.fighter_derived_metrics d on d.fighter_id = x.fighter_id
  left join ufc.fighter_career_stats    c on c.fighter_id = x.fighter_id
  left join ufc.fighter_style_metrics   s on s.fighter_id = x.fighter_id
  left join (select distinct fighter_id from ufc.fighter_fights) f on f.fighter_id = x.fighter_id;


-- ── 6. Fight history date coverage ─────────────────────────────────────────
-- The app tells the user the dataset is 2010–2026. This is what it really is.
select min(date) as earliest_fight,
       max(date) as latest_fight,
       count(*)  as fight_rows,
       count(distinct fighter_id) as fighters_with_history
  from ufc.fighter_fights;

-- Rows per year — a cliff at the top is the sync having stopped.
select extract(year from date)::int as year, count(*) as fights
  from ufc.fighter_fights
 where date is not null
 group by 1 order by 1 desc limit 12;


-- ── 7. UFC 330 specifically ─────────────────────────────────────────────────
-- Named-card lookup. Empty result means the card is not in the live tables at
-- all, which is the poller's window (it reads ESPN's scoreboard from 2 days
-- back forward), not a rendering bug.
select event_id, name, status, start_time, updated_at
  from ufc.live_events
 where name ilike '%330%'
 order by start_time desc;

select f.event_id, e.name, f.fight_id, f.red_name, f.blue_name, f.weight_class,
       f.is_main, f.status, f.round, f.clock,
       f.red_odds, f.blue_odds,
       f.red_strikes, f.blue_strikes, f.red_td, f.blue_td
  from ufc.live_fights f
  join ufc.live_events e using (event_id)
 where e.name ilike '%330%'
 order by f.is_main desc, f.fight_id;

-- Historical record of the same card, if the research dataset carries it:
select date, weight_class, count(*) as rows
  from ufc.fighter_fights
 where date between date '2026-01-01' and current_date
 group by 1,2 order by 1 desc limit 20;


-- ── 8. What the app's live picker will choose right now ────────────────────
-- Mirrors ufcPickEvent: live inside an 8h window, else next upcoming, else the
-- most recent stale row. If this returns something unexpected, the Fight Center
-- is showing you exactly what the table says.
select event_id, name, status, start_time, updated_at,
       now() - start_time as since_start,
       case when status <> 'post' and start_time <= now()
                 and now() - start_time < interval '8 hours'      then 'would render LIVE'
            when start_time > now()                              then 'would render UPCOMING'
            when status <> 'post'                                then 'STALE — poller never closed it'
            else 'finished' end as app_verdict
  from ufc.live_events
 order by start_time desc
 limit 15;

-- Duplicate pairings (migration 021 cleans these; this confirms they stay gone)
select event_id,
       lower(coalesce(red_name,'')) || ' vs ' || lower(coalesce(blue_name,'')) as pairing,
       count(*) as rows
  from ufc.live_fights
 group by 1,2 having count(*) > 1
 order by 3 desc;


-- ── 9. Build metadata and the pipeline ledger (migration 022) ───────────────
-- If ufc.meta does not exist, that is WHY the app says "no build time
-- published" — run migrations/022_ufc_meta.sql, then have the sync jobs stamp.
select to_regclass('ufc.meta')      as meta_table,
       to_regclass('ufc.build_log') as build_log_table;

select key, value, updated_at from ufc.meta order by key;

select * from ufc.pipeline_health;

-- Runs in the last week, including the failures.
select job, status, started_at, rows_written, left(coalesce(error,''), 120) as error
  from ufc.build_log
 where started_at > now() - interval '7 days'
 order by started_at desc
 limit 40;


-- ── 10. Can the APP's role actually read all this? ─────────────────────────
-- RLS with no policy returns zero rows to `authenticated` while `postgres`
-- sees everything — which looks identical to an empty table from the browser.
select c.relname as object,
       c.relrowsecurity as rls_on,
       (select count(*) from pg_policies p
         where p.schemaname = 'ufc' and p.tablename = c.relname) as policies,
       has_table_privilege('authenticated', ('ufc.' || c.relname)::regclass, 'select') as authenticated_can_select
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'ufc' and c.relkind in ('r','v')
 order by c.relname;

-- Rows the app role would actually see, table by table. Any zero here against a
-- non-zero count in section 2 is an RLS policy problem, not a data problem.
-- SET LOCAL only takes effect inside a transaction; run these four lines
-- together, not one at a time, or the counts come back as the superuser's and
-- tell you nothing.
begin;
set local role authenticated;
select 'fighters as authenticated' as check, count(*) from ufc.fighters
union all select 'live_events as authenticated', count(*) from ufc.live_events
union all select 'live_fights as authenticated', count(*) from ufc.live_fights;
rollback;


-- ── 11. Is a UFC model registered anywhere? ────────────────────────────────
-- The app gates live model probability and pre-fight CLV. It gates them because
-- nothing is registered — confirm that, rather than trusting the gate.
select * from public.research_model_current
 where lower(coalesce(model_key,'')) like '%ufc%'
    or lower(coalesce(model_key,'')) like '%mma%';

-- Everything registered, for context:
select model_key, maturity, updated_at from public.research_model_current order by model_key;


-- ── 12. Is capture actually pricing MMA? ───────────────────────────────────
-- ufc_live reads live fight prices out of public.signals. No rows here means
-- the MMA key is missing from capture_sports, and the fight cards will show no
-- odds — correctly, rather than showing invented ones.
select sport, count(*) as signal_rows,
       max(created_at) as newest,
       now() - max(created_at) as age
  from public.signals
 where sport ilike '%mma%' or sport ilike '%ufc%' or sport ilike '%boxing%'
 group by sport
 order by newest desc nulls last;
