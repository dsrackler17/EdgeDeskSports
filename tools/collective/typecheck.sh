#!/bin/sh
# Type checks the edge functions in both the form they are written (modules)
# and the form they are deployed (one flattened script per function).
#
# The flattened check is not redundant: bundling drops module scope, so a top
# level name that is fine in a module can collide with a global once inlined.
#
#   sh tools/collective/typecheck.sh            # uses npx typescript
#   TSC=/path/to/tsc sh tools/collective/typecheck.sh
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HERE="$ROOT/tools/collective"
TMP=${TMPDIR:-/tmp}/collective-tsc.$$
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

if [ -n "$TSC" ]; then RUN="$TSC"
elif command -v tsc >/dev/null 2>&1; then RUN="tsc"
else RUN="npx --yes typescript@5.9.3 tsc"; fi

echo "== modules =="
$RUN -p "$HERE/tsconfig.json"
echo "ok"

python3 "$HERE/bundle_functions.py" --check >/dev/null || {
  echo "bundles are out of date; run python3 tools/collective/bundle_functions.py" >&2
  exit 1
}

for f in "$ROOT"/supabase/functions/_bundles/*.bundle.ts; do
  name=$(basename "$f" .bundle.ts)
  echo "== bundle: $name =="
  cat > "$TMP/$name.json" <<JSON
{"compilerOptions":{"target":"ES2022","lib":["ES2022","DOM","DOM.Iterable"],
  "module":"ESNext","moduleResolution":"Bundler","strict":true,"noEmit":true,
  "skipLibCheck":true,"types":[]},
 "files":["$HERE/deno.d.ts","$f"]}
JSON
  $RUN -p "$TMP/$name.json"
  echo "ok"
done
echo
echo "ALL TYPE CHECKS PASSED"
