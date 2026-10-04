#!/usr/bin/env bash
# ===========================================================================
# ONE STAGE OF THE BILLING DEPLOYMENT (docs/billing-hardening.md §9a).
# Run by .github/workflows/deploy-billing.yml; every stage first re-checks what
# the stage before it promised, and stops at the first thing that does not
# hold. Nothing here prints a secret, a full email or a full account id: the
# logs of this repository's workflows are public.
#
#   preflight                       Phases 2–4  read-only report + role probe (rolled back)
#   apply_sql_dry_run               Phase 5     snapshot → migration → checks, ROLLED BACK
#   apply_sql                       Phase 5     the same, committed only behind the gate
#   deploy_sync_subscription        Phase 6
#   deploy_stripe_webhook           Phase 7
#   deploy_create_checkout_session  Phase 8     (optionally sets STRIPE_PRICE_ID)
#   apply_cron                      Phase 11    observes the first sweeps; STOP = unschedule
#   verify                          any time    every check again, plus one account's convergence
#   rollback_stripe_webhook | checkout_kill_switch | remove_sync_subscription | disable_cron
#
# ENV (repository secrets, presence-checked): SB_DB_URL, SB_URL, SB_SERVICE_ROLE,
#      SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF.  Inputs: STRIPE_PRICE_ID_INPUT,
#      SUBJECT_USER_ID.
# ===========================================================================
set -euo pipefail
STAGE="${1:?usage: deploy_stage.sh <stage>}"
cd "$(dirname "$0")/../.."

OUT="${RUNNER_TEMP:-/tmp}/billing-deploy"
mkdir -p "$OUT"
SUMMARY="${GITHUB_STEP_SUMMARY:-$OUT/summary.md}"
API="${SUPABASE_API:-https://api.supabase.com}/v1/projects/${SUPABASE_PROJECT_REF:-}"
SLUGS='["sync_subscription","stripe_webhook","create_checkout_session"]'
# the last stripe_webhook build before the hardening, and the commit it lives in
ROLLBACK_COMMIT=2c12f48bb7d46fc119b89c10215517503ee23d37
ROLLBACK_BUILD=stripe_webhook-2026-09-12-referral-1

section() { echo; echo "════ $*"; printf '\n### %s\n\n' "$*" >> "$SUMMARY"; }
note()    { echo "$*"; printf '%s\n\n' "$*" >> "$SUMMARY"; }
stop()    { echo "::error::$*"; printf '\n**STOP — %s**\n' "$*" >> "$SUMMARY"; exit 1; }
fence()   { { echo '```'; cat; echo '```'; } >> "$SUMMARY"; }

need() {
  local missing=()
  for v in "$@"; do [ -n "${!v:-}" ] || missing+=("$v"); done
  [ ${#missing[@]} -eq 0 ] || stop "missing repository secret(s): ${missing[*]} (Settings → Secrets and variables → Actions)"
}
psql_run() { psql "$SB_DB_URL" -X -A -t -F ' | ' -v ON_ERROR_STOP=1 "$@"; }
fails_in() { grep -cE '^[0-9]+ \| [^|]+ \| [^|]+ \| FAIL \|' "$1" || true; }
post_fails_in() { grep -cE '^[0-9]+ \| [0-9]+ \| [^|]+ \| FAIL \|' "$1" || true; }

expected_build() { sed -n "s/^const BUILD = '\([^']*\)';.*/\1/p" "supabase/functions/$1/index.ts" | head -1; }
serving_build() {
  curl -sS -m 15 -H "apikey: ${SB_ANON:-}" "${SB_URL%/}/functions/v1/$1" -o "$OUT/get_$1.json" -D "$OUT/get_$1.h" || true
  jq -r '.build // empty' "$OUT/get_$1.json" 2>/dev/null || true
}
wait_build() {   # name expected
  local got=""
  for _ in $(seq 1 24); do
    got="$(serving_build "$1")"
    [ "$got" = "$2" ] && { note "$1 is serving \`$2\`"; return 0; }
    sleep 5
  done
  stop "$1 is serving '${got:-nothing}', not '$2', two minutes after the deploy"
}

# ── what production is running: Edge Function versions and secret NAMES ────
deployed() {
  section "Deployed billing Edge Functions (Supabase Management API)"
  if curl -sS -m 20 -f -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" "$API/functions" -o "$OUT/functions.json"; then
    jq -c --argjson s "$SLUGS" '[.[] | select(.slug as $x | $s | index($x)) | {slug, version, status, verify_jwt, updated_at}]' \
      "$OUT/functions.json" > "$OUT/deployed.json"
    jq -r '.[] | "\(.slug)\tversion \(.version)\t\(.status)\tverify_jwt \(.verify_jwt)\tupdated \(.updated_at)"' "$OUT/deployed.json" | tee >(fence)
    [ "$(jq length "$OUT/deployed.json")" -gt 0 ] || note "none of the billing functions is deployed"
  else
    echo '[]' > "$OUT/deployed.json"
    note "WARN: the Management API did not answer; deployed versions not recorded"
  fi
  if curl -sS -m 20 -f -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" "$API/secrets" -o "$OUT/secrets.json"; then
    # NAMES only. The values never leave the API response file, which is deleted.
    note "Function secrets present: $(jq -r '[.[].name | select(test("^(STRIPE_|SB_|SITE_URL|BILLING_)"))] | sort | join(", ")' "$OUT/secrets.json")"
    rm -f "$OUT/secrets.json"
  fi
  node tools/billing/prod_probe.js functions | tee >(fence)
}
verify_jwt_off() {
  curl -sS -m 20 -f -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" "$API/functions" -o "$OUT/functions.json" || stop "Management API unreachable"
  local v; v="$(jq -r --arg s "$1" '.[] | select(.slug == $s) | .verify_jwt' "$OUT/functions.json")"
  [ "$v" = "false" ] || stop "$1 has verify_jwt=$v — it must be false (it verifies tokens itself; Stripe and pg_cron send none)"
  note "$1: verify_jwt is off (the function checks every token itself)"
}

# ── the database gates ─────────────────────────────────────────────────────
preflight() {
  section "Preflight (read-only) and behavioural access checks (rolled back)"
  psql_run -f tools/billing/sql/preflight.psql > "$OUT/preflight.txt" 2>&1 || { cat "$OUT/preflight.txt" | fence; cat "$OUT/preflight.txt"; stop "the preflight or the role probe failed (see above)"; }
  cat "$OUT/preflight.txt"
  fence < "$OUT/preflight.txt"
  local n; n="$(fails_in "$OUT/preflight.txt")"
  [ "$n" = "0" ] || stop "$n preflight check(s) FAIL — fix them (each row says how) before anything is applied"
  grep -q 'SKIP  ' "$OUT/preflight.txt" && note "WARN: the behavioural role probe was skipped (see SKIP above); the catalog checks still ran"
  note "Preflight: no FAIL."
}
verify_sql() {
  section "Postflight (A–I) against the pre-apply snapshot, and behavioural access checks"
  psql_run -f tools/billing/sql/verify.psql > "$OUT/verify.txt" 2>&1 || { fence < "$OUT/verify.txt"; cat "$OUT/verify.txt"; stop "verification failed (see above)"; }
  cat "$OUT/verify.txt"; fence < "$OUT/verify.txt"
  local n; n="$(post_fails_in "$OUT/verify.txt")"
  [ "$n" = "0" ] || stop "$n postflight check(s) FAIL"
}
apply_sql() {   # 0 = dry run, 1 = commit
  local label; label=$([ "$1" = 1 ] && echo apply || echo dry-run)
  section "billing_hardening.sql — $label (snapshot → migration → postflight → access checks, one transaction)"
  psql_run -v commit="$1" -v deployed="$(cat "$OUT/deployed.json")" -f tools/billing/sql/apply.psql > "$OUT/$label.txt" 2>&1 \
    || { cat "$OUT/$label.txt"; fence < "$OUT/$label.txt"; stop "the $label stopped; NOTHING was kept (one transaction)"; }
  cat "$OUT/$label.txt"; fence < "$OUT/$label.txt"
  grep -q 'CHECK THIS' "$OUT/$label.txt" && stop "the migration's own report says CHECK THIS"
  grep -q 'GATE  postflight and access checks passed' "$OUT/$label.txt" || stop "the gate did not report a pass"
  if [ "$1" = 1 ]; then grep -q '^COMMITTED' "$OUT/$label.txt" || stop "not committed"; else grep -q '^DRY RUN' "$OUT/$label.txt" || stop "dry run did not roll back"; fi
}
manual_sync_proven() {
  local n; n="$(psql_run -c "select count(*) from public.billing_sync_log where source in ('self','checkout_return','admin','checkout') and ok and outcome not in ('admitted','rate_limited') and at > now() - interval '14 days'" | tr -d ' ')"
  [ "${n:-0}" -gt 0 ] || stop "no successful manual reconciliation is on record yet — deploy_sync_subscription's probes make one, or press Settings → Refresh access"
  note "manual reconciliations on record (14 days): $n"
}
unschedule() {
  # nested, so a project without pg_cron never even parses the cron.job reference
  psql_run -c "do \$u\$ begin if to_regclass('cron.job') is not null then perform cron.unschedule(jobname) from cron.job where jobname = 'billing_reconcile_sweep'; end if; end \$u\$;" >/dev/null
}
deploy_fn() {
  section "Deploy $1"
  supabase functions deploy "$1" --project-ref "$SUPABASE_PROJECT_REF" --no-verify-jwt
  wait_build "$1" "$(expected_build "$1")"
  verify_jwt_off "$1"
}

# ── stages ─────────────────────────────────────────────────────────────────
need SB_DB_URL SB_URL SB_SERVICE_ROLE SUPABASE_ACCESS_TOKEN SUPABASE_PROJECT_REF
export SB_ANON="${SB_ANON:-$(sed -n 's/^var SB_KEY="\(eyJ[^"]*\)";.*/\1/p' index.html | head -1)}"
printf '## Billing deployment — stage `%s`\n\nCommit `%s`. Customer data in this log is masked; full detail stays in the database (billing_ops).\n' \
  "$STAGE" "$(git rev-parse --short HEAD)" >> "$SUMMARY"
deployed

case "$STAGE" in
  preflight)
    preflight
    section "Frontend (already merged to main, so already live)"
    node tools/billing/prod_probe.js frontend | tee >(fence) || note "WARN: the live site is not serving this commit's pages yet"
    ;;
  apply_sql_dry_run)
    preflight
    apply_sql 0
    ;;
  apply_sql)
    preflight
    apply_sql 0
    apply_sql 1
    verify_sql
    ;;
  deploy_sync_subscription)
    verify_sql
    deploy_fn sync_subscription
    section "Phase 6 probes (probe accounts only; never a real customer)"
    node tools/billing/prod_probe.js sync | tee >(fence) || stop "sync_subscription did not verify — to undo: stage remove_sync_subscription (the pages treat its absence as not deployed)"
    ;;
  deploy_stripe_webhook)
    verify_sql
    node tools/billing/prod_probe.js functions --require sync_subscription | tee >(fence) || stop "sync_subscription is not serving this commit"
    manual_sync_proven
    T0="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    deploy_fn stripe_webhook
    section "Phase 7 probes"
    node tools/billing/prod_probe.js webhook | tee >(fence) || stop "stripe_webhook did not verify — to undo: stage rollback_stripe_webhook"
    section "Phase 7 trace: the first real delivery through the new build (waits up to 10 minutes)"
    note "Speed it up: Stripe → Developers → Webhooks → this endpoint → pick a recent event → Resend. A resend is safe: the webhook re-reads Stripe and writes what is true now."
    node tools/billing/prod_probe.js trace --since "$T0" --wait "${BILLING_TRACE_WAIT_S:-600}" | tee >(fence) || stop "the traced delivery failed"
    ;;
  deploy_create_checkout_session)
    verify_sql
    node tools/billing/prod_probe.js functions --require sync_subscription,stripe_webhook | tee >(fence) || stop "the backend before it is not serving this commit"
    node tools/billing/prod_probe.js webhook | tee >(fence) || stop "stripe_webhook does not verify"
    if [ -n "${STRIPE_PRICE_ID_INPUT:-}" ]; then
      [[ "$STRIPE_PRICE_ID_INPUT" =~ ^price_[A-Za-z0-9]+$ ]] || stop "stripe_price_id must look like price_…"
      supabase secrets set "STRIPE_PRICE_ID=$STRIPE_PRICE_ID_INPUT" --project-ref "$SUPABASE_PROJECT_REF"
      note "STRIPE_PRICE_ID set (the function checks it against Stripe and the consent text before every session)"
    fi
    deploy_fn create_checkout_session
    section "Phase 8 probes (probe accounts only; leaves one open, unpaid session that expires in 24 hours)"
    node tools/billing/prod_probe.js checkout | tee >(fence) || stop "create_checkout_session did not verify — to undo: stage checkout_kill_switch (the page falls back to the Payment Link at once)"
    ;;
  apply_cron)
    verify_sql
    node tools/billing/prod_probe.js functions --require sync_subscription,stripe_webhook | tee >(fence) || stop "the backend is not serving this commit"
    manual_sync_proven
    section "What the first sweep will look at (counts only)"
    psql_run -c "select why, count(*) from public.billing_sweep_candidates(100) group by why order by why" | tee >(fence)
    T0="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    section "Apply supabase/billing_reconcile_cron.sql"
    psql_run -f supabase/billing_reconcile_cron.sql > "$OUT/cron.txt" 2>&1 || { cat "$OUT/cron.txt"; stop "the schedule did not apply"; }
    cat "$OUT/cron.txt"; fence < "$OUT/cron.txt"
    grep -q 'CHECK THIS' "$OUT/cron.txt" && stop "billing_reconcile_cron.sql reports CHECK THIS"
    section "Observe the first sweeps (up to 25 minutes)"
    set +e
    node tools/billing/prod_probe.js cron --since "$T0" --wait "${BILLING_CRON_WAIT_S:-1500}" | tee "$OUT/cron_obs.txt"
    rc=${PIPESTATUS[0]}
    set -e
    fence < "$OUT/cron_obs.txt"
    psql_run -c "select status, start_time, left(return_message, 120) from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'billing_reconcile_sweep') order by start_time desc limit 5" 2>/dev/null | tee >(fence) || true
    if [ "$rc" = 2 ]; then
      unschedule
      stop "the first sweeps did more than a healthy system should — the schedule was UNSCHEDULED again; investigate in /admin/billing/, then re-run apply_cron"
    fi
    [ "$rc" = 0 ] || stop "the sweep could not be observed"
    ;;
  verify)
    verify_sql
    section "Functions, webhook, frontend"
    node tools/billing/prod_probe.js webhook | tee >(fence) || note "WARN: the webhook probe did not pass (is the hardened build deployed yet?)"
    node tools/billing/prod_probe.js frontend | tee >(fence) || stop "the live site is not serving this commit"
    section "The latest delivery, end to end"
    node tools/billing/prod_probe.js trace --since "$(date -u -d '-24 hours' +%Y-%m-%dT%H:%M:%SZ)" | tee >(fence) || stop "the latest delivery did not trace cleanly"
    if [ -n "${SUBJECT_USER_ID:-}" ]; then
      [[ "$SUBJECT_USER_ID" =~ ^[0-9a-fA-F-]{36}$ ]] || stop "subject_user_id must be an account id"
      section "Has this account converged? (Phase 13)"
      node tools/billing/prod_probe.js subject --user "$SUBJECT_USER_ID" ${STRIPE_PRICE_ID_INPUT:+--price "$STRIPE_PRICE_ID_INPUT"} | tee >(fence) || stop "the account has not converged"
    fi
    section "Open alerts, unresolved deliveries, repairs, the schedule (counts)"
    psql_run -c "select 'open alerts' as what, coalesce(jsonb_object_agg(kind, n)::text, '{}') from (select kind, count(*) n from public.billing_alerts where resolved_at is null group by kind) t
                 union all select 'unresolved deliveries (14 days)', count(*)::text from public.stripe_events where not resolved and created_at > now() - interval '14 days'
                 union all select 'reconciliations (7 days) by source:outcome', coalesce(jsonb_object_agg(k, n)::text, '{}') from (select source || ':' || outcome k, count(*) n from public.billing_sync_log where outcome <> 'admitted' and at > now() - interval '7 days' group by 1) t
                 union all select 'sweep last run', coalesce((select last_run_at::text || ' ' || coalesce(last_result::text, '') from public.billing_sweep_state where id = 1), 'never')
                 union all select 'cron job', case when to_regclass('cron.job') is null then 'pg_cron not installed' when not has_table_privilege(to_regclass('cron.job'), 'select') then 'cron.job not readable' else coalesce((select x::text from unnest(xpath('//row/x/text()', query_to_xml('select jobname || '' '' || schedule || '' active '' || active::text as x from cron.job where jobname = ''billing_reconcile_sweep''', false, false, ''))) x limit 1), 'not scheduled') end" | tee >(fence)
    ;;
  rollback_stripe_webhook)
    section "Roll stripe_webhook back to $ROLLBACK_BUILD"
    git fetch --no-tags --depth=1 origin "$ROLLBACK_COMMIT"
    git show "$ROLLBACK_COMMIT:supabase/functions/stripe_webhook/index.ts" > supabase/functions/stripe_webhook/index.ts
    supabase functions deploy stripe_webhook --project-ref "$SUPABASE_PROJECT_REF" --no-verify-jwt
    wait_build stripe_webhook "$ROLLBACK_BUILD"
    verify_jwt_off stripe_webhook
    note "Rolled back. The old build works on the migrated schema (it upserts columns that still exist)."
    ;;
  checkout_kill_switch)
    section "Server-side checkout OFF: unset STRIPE_PRICE_ID"
    supabase secrets unset STRIPE_PRICE_ID --project-ref "$SUPABASE_PROJECT_REF" || true
    sleep 10
    node tools/billing/prod_probe.js checkout | tee >(fence) || true
    note "The page now falls back to the Payment Link (503 not_configured → fallback_ok). Re-enable with deploy_create_checkout_session + stripe_price_id."
    ;;
  remove_sync_subscription)
    section "Remove sync_subscription (and its schedule)"
    unschedule
    supabase functions delete sync_subscription --project-ref "$SUPABASE_PROJECT_REF"
    note "Removed. The pages treat a 404 as not deployed and keep reading the database."
    ;;
  disable_cron)
    section "Unschedule billing_reconcile_sweep"
    unschedule
    note "Unscheduled. Readers' Refresh access and the success page still reconcile on demand."
    ;;
  *) stop "unknown stage '$STAGE'" ;;
esac
note "Stage \`$STAGE\`: done, every check passed."
