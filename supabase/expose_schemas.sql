/* ===========================================================================
   EXPOSE mlbhist AND cbb TO THE API.

   WHY THIS FILE EXISTS. Running mlb_pitcher_history.sql, mlb_offense_history.sql
   and college_baseball.sql builds every table, view, function and policy, and
   their reports read ok. The app still says the contract is not installed, and
   the college card fails with "db 406".

   406 is the whole diagnosis. PostgREST answers HTTP 406 with error PGRST106
   when a request names a schema that is not in its db-schemas setting:

       {"code":"PGRST106","message":"The schema must be one of the following:
        public, graphql_public, ufc, cfb, wta, tennis, collective"}

   The tables exist. PostgREST simply refuses to serve them, so every read is a
   406 and every write is refused, and the app reports what it is actually told:
   nothing is there. No amount of further schema SQL changes this, because it is
   not a schema problem.

   THE NORMAL FIX IS A DASHBOARD SETTING — Supabase > Project Settings > API >
   Exposed schemas, add mlbhist and cbb. Prefer that: it is the setting Supabase
   itself manages, and it survives everything.

   THIS FILE IS THE SAME CHANGE MADE FROM SQL, for when the dashboard is not to
   hand. PostgREST reads its configuration from the authenticator role's own
   settings, so setting pgrst.db_schemas there and telling PostgREST to reload
   takes effect within seconds and persists in pg_db_role_setting.

   IT IS A COMPLETE LIST, NOT AN ADDITION. There is no "append" for this
   setting: whatever is written here becomes the entire set of served schemas.
   The seven below are the ones this project already served, read off the
   PGRST106 message above, and mlbhist and cbb are added to them. If your
   project serves anything else, add it to the list before running this, or that
   schema stops being served the moment this runs.

   WHAT THIS DOES NOT DO. It grants nothing. The three contract files already
   grant usage on their schema and select on their readable tables to anon and
   authenticated, and every table keeps the RLS it was created with. Exposing a
   schema only lets PostgREST route to it; it does not widen who may read what.
   =========================================================================== */

-- The complete set of schemas PostgREST will serve.
alter role authenticator set pgrst.db_schemas =
  'public, graphql_public, ufc, cfb, wta, tennis, collective, mlbhist, cbb';

-- Pick it up now rather than at the next restart.
notify pgrst, 'reload config';
notify pgrst, 'reload schema';

/* ---------------------------------------------------------------------------
   THE REPORT. Every row must read ok.

   Row 1 is the setting itself. Rows 2 and 3 are the reason it was worth setting:
   the schemas are present and readable. If row 1 reads ok and the app still
   answers 406 after a minute, PostgREST has not reloaded — set it from the
   dashboard instead, which restarts the service.
   --------------------------------------------------------------------------- */
with checks as (
  select 1 as n,
    'PostgREST is told to serve mlbhist and cbb' as guarantee,
    case when exists (
      select 1 from pg_db_role_setting s
      join pg_roles r on r.oid = s.setrole
      where r.rolname = 'authenticator'
        and exists (
          select 1 from unnest(s.setconfig) c
          where c like 'pgrst.db_schemas=%'
            and c like '%mlbhist%' and c like '%cbb%')
    ) then 'ok' else 'CHECK THIS — the setting did not take' end as result

  union all select 2,
    'nothing that was already served was dropped from the list',
    case when (
      select bool_and(position(want in c) > 0)
      from pg_db_role_setting s
      join pg_roles r on r.oid = s.setrole
      cross join lateral unnest(s.setconfig) c
      cross join lateral unnest(array['public','graphql_public','ufc','cfb',
                                      'wta','tennis','collective']) want
      where r.rolname = 'authenticator' and c like 'pgrst.db_schemas=%'
    ) then 'ok' else 'CHECK THIS — a schema this project served is no longer in the list' end

  union all select 3,
    'the archive schemas exist to be served',
    case when exists (select 1 from pg_namespace where nspname = 'mlbhist')
          and exists (select 1 from pg_namespace where nspname = 'cbb')
         then 'ok'
         else 'CHECK THIS — run the three contract files first' end

  union all select 4,
    'a reader may reach into both schemas',
    case when has_schema_privilege('anon', 'mlbhist', 'usage')
          and has_schema_privilege('anon', 'cbb', 'usage')
         then 'ok' else 'CHECK THIS — re-run the contract files; they grant this' end

  union all select 5,
    'exposing a schema did not widen who may read what',
    'ok (this file grants nothing; every table keeps the RLS it was created with)'
)
select n, guarantee, result from checks order by n;
