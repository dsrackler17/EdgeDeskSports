#!/usr/bin/env python3
"""The two deploy paths must agree about JWT enforcement.

There are two ways to ship a function: `supabase functions deploy`, which reads
verify_jwt from supabase/config.toml, and pasting a bundle into the dashboard,
which follows the header line the bundler writes from PUBLIC_FUNCTIONS.

If those disagree, the gateway posture depends on which path was used last —
and that is invisible from either side. Getting it wrong in one direction locks
out a caller that authenticates in code (pg_net has no JWT to send); in the
other it fronts a writer with a check that any visitor can satisfy, since the
anon key is in the site's page source.

    python3 tests/collective/config_matches_bundles.py
"""

from __future__ import annotations

import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "collective"))

from bundle_functions import PUBLIC_FUNCTIONS, function_names  # noqa: E402

CONFIG = ROOT / "supabase" / "config.toml"


def main() -> int:
    if not CONFIG.exists():
        print(f"FAIL: {CONFIG.relative_to(ROOT)} is missing", file=sys.stderr)
        return 1

    cfg = tomllib.loads(CONFIG.read_text(encoding="utf-8")).get("functions", {})
    names = function_names()
    problems = []

    for name in names:
        want_jwt_off = name in PUBLIC_FUNCTIONS
        entry = cfg.get(name)
        if entry is None or "verify_jwt" not in entry:
            problems.append(
                f"{name}: no [functions.{name}] verify_jwt in config.toml, so the "
                f"CLI would deploy it with the default instead of the intended setting"
            )
            continue
        if entry["verify_jwt"] is not (not want_jwt_off):
            problems.append(
                f"{name}: bundler header says JWT "
                f"{'OFF' if want_jwt_off else 'ON'}, config.toml says "
                f"verify_jwt={entry['verify_jwt']}"
            )
            continue
        print(f"pass: {name} agrees (verify_jwt={entry['verify_jwt']})")

    # A stale entry for a function that no longer exists is a smaller problem,
    # but it is still a claim about something the repo cannot deploy.
    for name in sorted(set(cfg) - set(names)):
        problems.append(f"{name}: in config.toml but has no source under supabase/functions/")

    if problems:
        print()
        for p in problems:
            print(f"FAIL: {p}", file=sys.stderr)
        return 1

    print(f"\n{len(names)} functions agree across both deploy paths")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
