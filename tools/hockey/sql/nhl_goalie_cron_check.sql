-- Is pg_cron calling the goalie sync? One line of JSON for
-- .github/workflows/nhl-goalie-sync.yml (tools/hockey/nhl_goalie_run_summary.js
-- judges it): the job, its schedule, whether it is active, its last call and
-- that call's status, and the failed calls in the last hour.
with j as (select jobid, schedule, active from cron.job where jobname = 'nhl_goalie_sync' limit 1),
     d as (select status, return_message, start_time from cron.job_run_details where jobid = (select jobid from j) order by start_time desc limit 1)
select json_build_object('exists', exists (select 1 from j), 'schedule', (select schedule from j), 'active', (select active from j),
                         'last_start', (select start_time from d), 'last_status', (select status from d), 'last_message', (select return_message from d),
                         'failed_1h', (select count(*) from cron.job_run_details where jobid = (select jobid from j) and status = 'failed' and start_time > now() - interval '1 hour'));
