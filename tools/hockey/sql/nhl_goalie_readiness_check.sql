-- The readiness row the NHL goalie jobs judge (.github/workflows/nhl-goalie-sync.yml,
-- deploy-nhl-goalie.yml; tools/hockey/nhl_goalie_run_summary.js): one line of
-- JSON, public.nhl_goalie_readiness plus last_check_alerts, the "SEVERITY:code"
-- of the last run that checked the sources, so a run that failed only because
-- no outside source answered is told from one that failed in EdgeDesk's code.
select row_to_json(r)::jsonb || jsonb_build_object('last_check_alerts', coalesce((
         select jsonb_agg(distinct a.severity || ':' || a.code)
           from public.nhl_goalie_alerts a
          where a.run_id = (select s.run_id from public.nhl_goalie_sync_runs s where s.status <> 'skipped' order by s.finished_at desc limit 1)), '[]'::jsonb))
  from public.nhl_goalie_readiness r;
