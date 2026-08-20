-- CFB SCHEDULE, EXPORT AS CSV
--
-- Produces the same four columns as the NFL schedule file. Run it in the
-- Supabase SQL editor, click "Download CSV" above the results, then drop that
-- file straight into Admin, Games. The Games tab reads the header row and the
-- quoting Supabase adds, so no cleanup is needed.
--
-- Source is the cfb schema EdgeDesk already ingests from CollegeFootballData,
-- so it is always as current as your last ingest.

-- If the column names below do not match your table, run this first and read
-- the output, then edit the four marked lines:
--   select column_name, data_type from information_schema.columns
--   where table_schema = 'cfb' and table_name = 'games' order by ordinal_position;

select
  week                                                                   as week,
  to_char(start_date at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')   as kickoff,
  home_team                                                              as home,
  away_team                                                              as away
from cfb.games            -- <<< your games table
where season = 2026       -- <<< the season
  and coalesce(season_type, 'regular') = 'regular'
  and start_date is not null
order by start_date, home_team;

-- Notes
--
-- Zero rows means your cfb ingest has not pulled 2026 yet. Run that ingest
-- first; nothing here needs changing.
--
-- Games against FCS opponents are included in the export. The Collective only
-- knows the 136 FBS programs, so those lines are reported as unmatched after
-- upload and simply not created. That is expected, not an error: no creator is
-- projecting an FCS tune-up game. Add an alias under Admin, Quarantine if you
-- ever do want one of them.
