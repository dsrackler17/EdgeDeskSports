-- ===========================================================================
-- EdgeDesk NBA — roll back supabase/nba_engine.sql.
--
-- Drops the nbahist schema and everything in it. Nothing outside the schema
-- references it (the committed files under nba/ remain the source of truth and
-- nba/tools/sync_supabase.js can reload it). The odds-gateway row for
-- basketball_nba is NOT touched here: supabase/nba_odds_sport.sql manages it.
-- ===========================================================================
drop schema if exists nbahist cascade;
select 'nbahist dropped' as check, case when not exists (select 1 from information_schema.schemata where schema_name = 'nbahist') then 'ok' else 'CHECK THIS' end as result;
