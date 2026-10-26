-- Is pg_cron calling the goalie sync, and is the sync answering it? One line
-- of JSON for .github/workflows/nhl-goalie-sync.yml
-- (tools/hockey/nhl_goalie_run_summary.js judges it): the job, its schedule,
-- whether it is active, its last call and that call's status, the failed calls
-- in the last hour, and what the function answered the last three pokes
-- (public.nhl_goalie_pokes joined to pg_net's net._http_response; a poke younger
-- than 20 seconds may not have its answer yet and is left out).
with j as (select jobid, schedule, active from cron.job where jobname = 'nhl_goalie_sync' limit 1),
     d as (select status, return_message, start_time from cron.job_run_details where jobid = (select jobid from j) order by start_time desc limit 1),
     a as (select p.queued_at, r.status_code, r.timed_out, r.error_msg, left(r.content::text, 200) as content
             from public.nhl_goalie_pokes p left join net._http_response r on r.id = p.request_id
            where p.queued_at < now() - interval '20 seconds'
            order by p.queued_at desc limit 3)
select json_build_object('exists', exists (select 1 from j), 'schedule', (select schedule from j), 'active', (select active from j),
                         'last_start', (select start_time from d), 'last_status', (select status from d), 'last_message', (select return_message from d),
                         'failed_1h', (select count(*) from cron.job_run_details where jobid = (select jobid from j) and status = 'failed' and start_time > now() - interval '1 hour'),
                         'answers', (select coalesce(json_agg(json_build_object('queued_at', queued_at, 'status', status_code, 'timed_out', timed_out, 'error', error_msg, 'content', content) order by queued_at desc), '[]'::json) from a));
