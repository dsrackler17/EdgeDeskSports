#!/usr/bin/env bash
# ============================================================================
# EdgeDesk — commit generated artifacts and push them to a branch that other
# jobs are pushing to at the same time.
#
# WHY THIS EXISTS. Fourteen scheduled jobs commit to main, and the editorial
# job alone commits every ten minutes. A job that runs `git push` once loses
# that race and fails after every test has passed (games-challenges,
# football-weekly-build). A job that retries with `git pull --rebase` fails
# differently: the rebase conflicts on a generated file both sides rewrote,
# stops with unmerged paths, and every remaining attempt fails on "you have
# unmerged files" (editorial, 2026-09-14 23:50). Neither is a code problem;
# both are the same missing procedure.
#
# THE PROCEDURE. Our artifacts are a function of the run, not of history, so
# they never need merging: when the push is rejected, take the remote tip as
# it is now, put OUR versions of OUR paths on top of it, commit that, push
# again. Nothing outside the named paths is ever touched, and a rebase is
# never attempted. If the remote already carries byte-identical artifacts
# (another run published the same thing first) there is nothing to push and
# that is success.
#
# Usage
#   tools/ci/push_generated.sh <branch> <commit message> -- <path> [<path>...]
#
# Exit 0 when the artifacts are on the branch (pushed now, or already there);
# non-zero when they are not, with the reason on stderr. Never force-pushes.
#
# Environment
#   PUSH_ATTEMPTS   how many pushes to try (default 6; backoff 2,4,8,16,32 s)
#   PUSH_REMOTE     remote name (default origin)
#   PUSH_SLEEP      override the backoff (seconds) — the tests set it to 0
#   PUSH_MERGE_PATHS  space-separated paths among the named ones that are
#                   SOURCE, not artifacts (app.html, which build steps patch
#                   in place). On a rejected push these are never overwritten
#                   with our copy — that would silently revert whatever landed
#                   on the branch meanwhile (a merged pull request). Instead our
#                   own change to them is applied as a 3-way merge onto the new
#                   tip; if it does not apply cleanly, nothing is pushed and the
#                   script fails (a missed publish, never a reverted change).
# ============================================================================
set -euo pipefail

BRANCH="${1:-}"; MESSAGE="${2:-}"
if [ -z "$BRANCH" ] || [ -z "$MESSAGE" ] || [ "${3:-}" != "--" ] || [ $# -lt 4 ]; then
  echo "usage: $0 <branch> <commit message> -- <path> [<path>...]" >&2
  exit 64
fi
shift 3
PATHS=("$@")
REMOTE="${PUSH_REMOTE:-origin}"
ATTEMPTS="${PUSH_ATTEMPTS:-6}"

# paths that exist in the working tree or are tracked: `git add -A -- x`
# aborts on a pathspec that matches nothing, and a new artifact's first run
# is exactly when one is absent
present() {
  local out=() p
  for p in "${PATHS[@]}"; do
    if [ -e "$p" ] || git ls-files --error-unmatch -- "$p" >/dev/null 2>&1; then out+=("$p"); fi
  done
  printf '%s\n' "${out[@]:-}"
}

stage() {
  local have
  have=$(present)
  [ -n "$have" ] || return 0
  printf '%s\n' "$have" | tr '\n' '\0' | xargs -0 git add -A --
}

stage
if git diff --cached --quiet; then
  echo "nothing changed under: ${PATHS[*]} — no commit"
  exit 0
fi
BASE=$(git rev-parse HEAD)
git commit -q -m "$MESSAGE"
MINE=$(git rev-parse HEAD)
ORIG_MINE="$MINE"
echo "committed $MINE: $MESSAGE"

read -r -a MERGE <<< "${PUSH_MERGE_PATHS:-}"
is_merge() {
  local m
  for m in "${MERGE[@]:-}"; do [ -n "$m" ] && [ "$m" = "$1" ] && return 0; done
  return 1
}

i=0
while [ "$i" -lt "$ATTEMPTS" ]; do
  i=$((i + 1))
  if git push "$REMOTE" "HEAD:refs/heads/$BRANCH"; then
    echo "pushed to $BRANCH on attempt $i"
    exit 0
  fi
  echo "push to $BRANCH rejected on attempt $i; rebuilding the commit on the remote tip" >&2
  # abandon any half-state a previous tool may have left, then stand on the
  # remote tip exactly
  git rebase --abort 2>/dev/null || true
  git merge --abort 2>/dev/null || true
  git fetch -q "$REMOTE" "$BRANCH"
  git reset -q --hard FETCH_HEAD
  # OUR artifacts on top: every named path becomes exactly what our commit
  # holds, deletions included
  for p in "${PATHS[@]}"; do
    if is_merge "$p"; then continue; fi
    git rm -r -q --cached --ignore-unmatch -- "$p" 2>/dev/null || true
    rm -rf -- "$p"
    git checkout -q "$MINE" -- "$p" 2>/dev/null || true
  done
  # source paths: OUR change (the first commit's diff), merged onto the tip
  for p in "${MERGE[@]:-}"; do
    [ -n "$p" ] || continue
    if git diff --quiet "$BASE" "$ORIG_MINE" -- "$p"; then continue; fi
    if ! git diff --binary "$BASE" "$ORIG_MINE" -- "$p" | git apply --3way --index -q 2>/dev/null; then
      echo "our change to $p does not apply to the new tip of $BRANCH (it changed there too);" >&2
      echo "refusing to overwrite it — nothing pushed" >&2
      git reset -q --hard FETCH_HEAD
      exit 1
    fi
  done
  stage
  if git diff --cached --quiet; then
    echo "the branch already carries these exact artifacts — nothing left to push"
    exit 0
  fi
  git commit -q -m "$MESSAGE"
  MINE=$(git rev-parse HEAD)
  if [ "$i" -lt "$ATTEMPTS" ]; then sleep "${PUSH_SLEEP:-$((2 ** i))}"; fi
done
echo "could not push to $BRANCH after $ATTEMPTS attempts" >&2
exit 1
