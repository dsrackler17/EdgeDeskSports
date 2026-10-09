#!/usr/bin/env bash
# ===========================================================================
# DB doctor — what is the database actually doing right now?
#
# Written on 2026-10-09, when every reader got "Database — read failed" and
# every job here got 504s and aborted fetches from ~08:20 UTC on. PostgREST
# answering "upstream request timeout" on GET /rest/v1/ says the database (or
# its connection pool) is stuck. It does not say WHY, and nothing in this
# repository could look inside: every job speaks PostgREST, which is the thing
# that had stopped answering.
#
# So this asks the database itself, twice over:
#   1. the Management API (api.supabase.com) — project status, per-service
#      health, and SQL run through the platform's own connection, which does
#      not queue behind an exhausted client pool;
#   2. psql over SB_DB_URL, as a fallback if the Management API cannot run SQL.
#
# ACTION (env):
#   diagnose      (default) read-only: status, health, sessions, locks, cron
#   cancel-stuck  diagnose, then terminate client backends that are idle in a
#                 transaction for >5 min or running one statement for >10 min
#                 (never the platform's own roles), then diagnose again
#   restart       diagnose, then POST /v1/projects/{ref}/restart and poll health
#
# NEEDS: SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF (the deploy workflows'
# secrets) and/or SB_DB_URL. No secret value is ever printed.
# ===========================================================================
set -uo pipefail

ACTION="${ACTION:-diagnose}"
REF="${SUPABASE_PROJECT_REF:-}"
TOKEN="${SUPABASE_ACCESS_TOKEN:-}"
API="https://api.supabase.com/v1/projects/${REF}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"

have_api() { [ -n "$REF" ] && [ -n "$TOKEN" ]; }

api() { # METHOD PATH [BODY]
  local m="$1" p="$2" b="${3:-}"
  if [ -n "$b" ]; then
    curl -sS --max-time 90 -X "$m" "${API}${p}" -H "Authorization: Bearer ${TOKEN}" \
      -H 'content-type: application/json' --data "$b" -w '\n__HTTP__%{http_code}'
  else
    curl -sS --max-time 90 -X "$m" "${API}${p}" -H "Authorization: Bearer ${TOKEN}" -w '\n__HTTP__%{http_code}'
  fi
}

tabulate() { if command -v column >/dev/null 2>&1; then column -t -s $'\t'; else cat; fi; }

SQL_VIA=""
sql() { # TITLE QUERY — prints the rows as a table, via the API, else psql
  local title="$1" q="$2" out code body
  echo
  echo "### ${title}"
  if have_api && [ "$SQL_VIA" != "psql" ]; then
    out="$(api POST /database/query "$(jq -n --arg q "$q" '{query:$q}')" 2>&1)"
    code="${out##*__HTTP__}"; body="${out%__HTTP__*}"
    if [ "$code" = "200" ] || [ "$code" = "201" ]; then
      SQL_VIA="api"
      echo "$body" | jq -r 'if type=="array" and length>0 then ((.[0]|keys_unsorted) as $k | ($k|@tsv), (.[] | [.[$k[]]] | map(if .==null then "" else tostring end) | @tsv)) elif type=="array" then "(no rows)" else tostring end' 2>/dev/null \
        | tabulate || echo "$body"
      return
    fi
    echo "(management API SQL answered HTTP ${code}: $(echo "$body" | head -c 300))"
    # a stalled database answers 544 after a 15s connect timeout on every call;
    # pay that once, not once per query
    case "$code" in 5*|000) SQL_VIA="psql" ;; esac
  fi
  if [ -n "${SB_DB_URL:-}" ]; then
    PGCONNECT_TIMEOUT=20 psql "$SB_DB_URL" -X -v ON_ERROR_STOP=1 -P pager=off \
      -c "set statement_timeout='30s'" -c "$q" 2>&1 | grep -v '^SET$' | head -120 \
      || echo "(psql failed)"
  else
    echo "(no SQL path: neither the Management API nor SB_DB_URL answered)"
  fi
}

project_status() {
  echo "## Project"
  if ! have_api; then echo "SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF not set: no Management API view"; return; fi
  local out code body
  out="$(api GET '' 2>&1)"; code="${out##*__HTTP__}"; body="${out%__HTTP__*}"
  echo "GET project -> HTTP ${code}"
  echo "$body" | jq -c '{name, status, region, created_at, database: (.database // null)}' 2>/dev/null || echo "$body" | head -c 400
  out="$(api GET '/health?services=db&services=rest&services=pooler&services=auth&services=realtime&services=storage' 2>&1)"
  code="${out##*__HTTP__}"; body="${out%__HTTP__*}"
  echo "GET health -> HTTP ${code}"
  echo "$body" | jq -c '.[] | {name, healthy, status, error: (.error // null)}' 2>/dev/null || echo "$body" | head -c 600
  # compute size and disk: a database that does not fit the instance's memory
  # reads from disk on every query, and the smaller instances throttle disk IO
  # once their burst budget is spent
  out="$(api GET '/billing/addons' 2>&1)"; code="${out##*__HTTP__}"; body="${out%__HTTP__*}"
  echo "GET billing/addons -> HTTP ${code}"
  echo "$body" | jq -c '[.selected_addons[]? | {type, variant: (.variant.identifier // .variant.name // null)}]' 2>/dev/null || echo "$body" | head -c 400
  out="$(api GET '/config/disk' 2>&1)"; code="${out##*__HTTP__}"; body="${out%__HTTP__*}"
  echo "GET config/disk -> HTTP ${code}: $(echo "$body" | jq -c . 2>/dev/null || echo "$body" | head -c 300)"
  out="$(api GET '/config/disk/util' 2>&1)"; code="${out##*__HTTP__}"; body="${out%__HTTP__*}"
  echo "GET config/disk/util -> HTTP ${code}: $(echo "$body" | jq -c . 2>/dev/null || echo "$body" | head -c 300)"
}

diagnose() {
  project_status
  echo
  echo "## Inside the database"
  sql "Overview" "select now() as db_now, pg_postmaster_start_time() as up_since,
    current_setting('max_connections') as max_conn,
    (select count(*) from pg_stat_activity) as backends,
    (select count(*) from pg_stat_activity where state='active') as active,
    (select count(*) from pg_stat_activity where state like 'idle in transaction%') as idle_in_xact,
    pg_size_pretty(pg_database_size(current_database())) as db_size,
    pg_is_in_recovery() as in_recovery,
    current_setting('default_transaction_read_only') as read_only"
  sql "Sessions by role / app / state" "select usename, left(coalesce(application_name,''),40) as app, state, wait_event_type as wait,
    count(*) as n, max(now()-coalesce(xact_start,query_start))::text as oldest
    from pg_stat_activity where backend_type='client backend'
    group by 1,2,3,4 order by n desc limit 40"
  sql "Oldest non-idle statements" "select pid, usename, left(coalesce(application_name,''),30) as app, state,
    wait_event_type||':'||coalesce(wait_event,'') as wait,
    date_trunc('second', now()-xact_start)::text as xact_age,
    date_trunc('second', now()-query_start)::text as query_age,
    pg_blocking_pids(pid)::text as blocked_by,
    left(regexp_replace(query, '\s+', ' ', 'g'), 220) as query
    from pg_stat_activity
    where backend_type='client backend' and pid<>pg_backend_pid() and state<>'idle'
    order by coalesce(xact_start, query_start) asc nulls last limit 30"
  sql "Ungranted locks" "select l.pid, l.locktype, l.mode, l.relation::regclass::text as rel,
    pg_blocking_pids(l.pid)::text as blocked_by,
    date_trunc('second', now()-a.query_start)::text as waiting,
    left(regexp_replace(a.query, '\s+', ' ', 'g'), 160) as query
    from pg_locks l join pg_stat_activity a using (pid) where not l.granted limit 40"
  sql "Background workers / vacuum" "select a.pid, a.backend_type, a.state, date_trunc('second', now()-a.query_start)::text as age,
    p.relid::regclass::text as vacuuming, p.phase
    from pg_stat_activity a left join pg_stat_progress_vacuum p using (pid)
    where a.backend_type not in ('client backend') order by a.backend_type"
  sql "pg_cron: last 10 hours" "select j.jobname, d.status, to_char(d.start_time at time zone 'utc','MM-DD HH24:MI:SS') as start_utc,
    date_trunc('second', coalesce(d.end_time, now())-d.start_time)::text as took,
    left(regexp_replace(coalesce(d.return_message,''), '\s+', ' ', 'g'), 140) as msg
    from cron.job_run_details d left join cron.job j using (jobid)
    where d.start_time > now()-interval '10 hours' order by d.start_time desc limit 120"
  sql "pg_cron: jobs" "select jobid, jobname, schedule, active, left(regexp_replace(command, '\s+', ' ', 'g'), 110) as command from cron.job order by jobid"
  sql "pg_net backlog" "select (select count(*) from net.http_request_queue) as queued,
    (select count(*) from net._http_response where created > now()-interval '1 hour') as responses_1h,
    (select count(*) from net._http_response where created > now()-interval '1 hour' and (status_code is null or status_code>=400)) as failed_1h"
  sql "Largest tables" "select relname, pg_size_pretty(pg_total_relation_size(relid)) as total, n_live_tup, n_dead_tup,
    to_char(last_autovacuum,'MM-DD HH24:MI') as last_autovac
    from pg_stat_user_tables order by pg_total_relation_size(relid) desc limit 20"
}

cancel_stuck() {
  sql "Terminating stuck client backends" "select pid, usename, state,
    date_trunc('second', now()-coalesce(xact_start,query_start))::text as age,
    left(regexp_replace(query, '\s+', ' ', 'g'), 160) as query,
    pg_terminate_backend(pid) as terminated
    from pg_stat_activity
    where backend_type='client backend' and pid<>pg_backend_pid()
      and usename not in ('supabase_admin','supabase_replication_admin','supabase_read_only_user','pgbouncer','supabase_storage_admin','supabase_auth_admin','supabase_realtime_admin')
      and ((state like 'idle in transaction%' and state_change < now()-interval '5 minutes')
        or (state='active' and query_start < now()-interval '10 minutes'))"
}

restart_project() {
  if ! have_api; then echo "::error::restart needs SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF"; return 1; fi
  echo "## Restarting the project"
  local out code
  out="$(api POST /restart 2>&1)"; code="${out##*__HTTP__}"
  echo "POST restart -> HTTP ${code}: $(echo "${out%__HTTP__*}" | head -c 300)"
  for i in $(seq 1 30); do
    sleep 20
    out="$(api GET '/health?services=db&services=rest&services=pooler' 2>&1)"
    echo "[$i] $(echo "${out%__HTTP__*}" | jq -c '[.[] | {name, healthy, status}]' 2>/dev/null || echo "${out%__HTTP__*}" | head -c 200)"
    echo "${out%__HTTP__*}" | jq -e 'length>0 and all(.[]; .healthy==true)' >/dev/null 2>&1 && { echo "healthy again"; return 0; }
  done
  echo "::warning::not healthy after 10 minutes of polling"
}

probe_rest() {
  [ -n "${SB_URL:-}" ] && [ -n "${SB_SERVICE_ROLE:-}" ] || return 0
  echo
  echo "## PostgREST as the app sees it"
  curl -sS -o /dev/null --max-time 60 -w "signals heartbeat -> HTTP %{http_code} in %{time_total}s\n" \
    "${SB_URL}/rest/v1/signals?select=last_seen_at&last_seen_at=not.is.null&order=last_seen_at.desc.nullslast&limit=1" \
    -H "apikey: ${SB_SERVICE_ROLE}" -H "authorization: Bearer ${SB_SERVICE_ROLE}" || echo "(no answer)"
}

{
  echo "# DB doctor · action: ${ACTION} · $(date -u +%FT%TZ)"
  probe_rest
  diagnose
  case "$ACTION" in
    cancel-stuck) echo; cancel_stuck; sleep 5; echo; echo "# After"; diagnose; probe_rest ;;
    restart) echo; restart_project; echo; echo "# After"; probe_rest; diagnose ;;
  esac
} 2>&1 | tee /tmp/db_doctor.md

{ echo '```'; cat /tmp/db_doctor.md; echo '```'; } >> "$SUMMARY"
