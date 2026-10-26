#!/usr/bin/env bash
# ============================================================================
# EdgeDesk — check and attest HEAD before a job's raw `git push` to main.
#
# For the jobs that commit with their own retry loop instead of
# tools/ci/push_generated.sh. Put it in front of the push:
#
#   bash tools/ci/attest_head.sh && git push origin main && exit 0
#
# It checks the files HEAD changes against the remote branch (merge-base of
# HEAD and origin/<branch>, which `git pull --rebase` has just updated) and
# gives the commit the integrity-gate status main requires
# (tools/integrity/attest.js). Exit non-zero when the files fail the check:
# the push is skipped and the job's loop reports it could not publish.
#
# Environment: ATTEST_BRANCH (default main), PUSH_REMOTE (default origin).
# ============================================================================
set -euo pipefail
REMOTE="${PUSH_REMOTE:-origin}"
BRANCH="${ATTEST_BRANCH:-main}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE=$(git merge-base HEAD "refs/remotes/$REMOTE/$BRANCH" 2>/dev/null || git rev-parse 'HEAD^')
exec node "$HERE/../integrity/attest.js" --head HEAD --base "$BASE" --remote "$REMOTE"
