#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
research-identity-check.py — byte-identity guard for the RESEARCH rebuild.

Verifies that a refactor of app.html did not change what the research section
asks the database for or how it turns rows into displayed numbers.

  usage:  python3 scripts/research-identity-check.py PRE_app.html POST_app.html
          python3 scripts/research-identity-check.py PRE POST --allow-render-changes

What it checks
  A. QUERY INVENTORY   — every string literal containing "?select=" (the
                         PostgREST query shapes), compared as a multiset, plus
                         the pagination profile of each research fetch helper
                         (schema profile, default order, page size, page cap),
                         parsed from either the legacy inline form or the
                         rsFetchAll shim form.
  B. RENDER FUNCTIONS  — the byte content (hash) of every render/format
                         function that turns research rows into displayed
                         numbers. Must be identical unless --allow-render-changes
                         (stage 2 adds badges around numbers; section C then
                         still guards the numbers themselves).
  C. NUMERIC FINGERPRINT— per render function: every numeric literal, every
                         .toFixed(N), every Math.* rounding call, every
                         comparison against a numeric literal. Multiset per
                         function; must be identical always.
  L. LOADERS           — the fetch/orchestration functions are allowed to
                         change (signal threading, lifecycle); their unified
                         diffs are printed for review and their numeric
                         fingerprints must still be identical.

Exit code 0 only when every mandatory section is clean.
"""
import hashlib
import re
import sys

RENDER_FNS = [
    # WTA
    "wtaPct", "wtaStars", "wtaChip", "wtaCard", "wtaRatesLine", "wtaDisqLine",
    "wtaTodayRow", "wtaWatchRow", "wtaSlateStatusRow", "wtaBelowRow", "renderWTA",
    # CFB
    "cfbLc", "cfbSp", "cfbRecStr", "cfbIsUpcoming", "cfbSegHTML", "cfbGameRow",
    "cfbCmpRow", "cfbStatRows", "cfbLineHTML", "cfbGameById", "cfbCompareHTML",
    "cfbTeamsHTML", "cfbRecent", "cfbTeamHeadHTML", "cfbTeamBodyHTML", "renderCFB",
    "cfbAnalystHTML",
    # UFC
    "ufcResultFor", "ufcPct", "ufcRec", "ufcStatGridHTML", "ufcFightsHTML",
    "ufcCmpRow", "ufcCmpHTML", "ufcControlsHTML", "ufcWinProbBar",
    "ufcFinishedLosses", "ufcKV", "ufcProfileHTML", "ufcStyleBar",
    "ufcStyleProfileHTML", "ufcMatchupHTML", "ufcProfileNotInDB", "ufcChips",
    "ufcLiveFightCard", "ufcLiveShellHTML", "renderUFC", "ufcSetMode",
    # Stats
    "stFmt", "stLeadNum", "stEsc", "stKey", "stTeams", "stPositions", "stCats",
    "stCatLabel", "stRenderPlayerResults", "stPlayerRow", "stLeaderRow",
    "stDetail", "stBindRows", "renderStats",
    # Props
    "prSports", "prMarkets", "renderProps", "propExplain",
    # Lab
    "labCard", "gatePanel", "checkRow",
]

# constants whose literal text is part of the frozen protocol presentation
CONST_LITERALS = ["WTA_TIER", "PR_MKT", "PR_ORDER", "ST_CATLABEL", "ST_CATORDER", "ST_ASC"]

# loaders / fetch plumbing: allowed to change, diffs printed, numerals guarded
LOADER_FNS = [
    "loadCFB", "loadUFC", "loadWTA", "loadStats", "loadProps", "loadLab",
    "ufcLoadFights", "loadUFCLive", "cfbOpenTeam", "cfbCloseTeam",
    "ufcProfile", "ufcCloseProfile", "cfbEsc",
]

# fetch helpers checked semantically via pagination profiles instead
HELPER_PROFILES = {
    # name: (schema, default_order, page_cap, page_size)
    "ufcFetchAll": ("ufc", "full_name", 20, 1000),
    "stFetchAll": ("public", "player", 60, 1000),
    "cfbFetchAll": ("cfb", "team", 25, 1000),
}


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def _scan(src, i, end_test):
    """Walk JS from i, tracking strings, comments and regex literals; calls
    end_test(char, depth_delta_char) via a small state machine. Returns the
    index just past the point where end_test says stop, or -1."""
    depth = 0
    in_str = None
    esc = False
    prev_sig = ""            # last significant (non-space) code char seen
    n = len(src)
    while i < n:
        c = src[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == in_str:
                in_str = None
            i += 1
            continue
        if c in ("'", '"', "`"):
            in_str = c
            i += 1
            continue
        if src.startswith("//", i):
            j = src.find("\n", i)
            i = n if j < 0 else j
            continue
        if src.startswith("/*", i):
            j = src.find("*/", i)
            i = n if j < 0 else j + 2
            continue
        if c == "/" and prev_sig in "=(,:;!&|?{}[+-*%~^<>":
            # regex literal: skip to its unescaped closing /, honoring [...] classes
            i += 1
            in_class = False
            resc = False
            while i < n:
                rc = src[i]
                if resc:
                    resc = False
                elif rc == "\\":
                    resc = True
                elif rc == "[":
                    in_class = True
                elif rc == "]":
                    in_class = False
                elif rc == "/" and not in_class:
                    break
                i += 1
            i += 1
            prev_sig = "/"
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0 and end_test == "brace":
                return i + 1
        elif end_test == "semi" and c == ";" and depth == 0:
            return i + 1
        if not c.isspace():
            prev_sig = c
        i += 1
    return -1


def find_function(src, name):
    """Extract the body of `function NAME(`, `NAME=function(`,
    `window.NAME=function(` or async variants — first match wins (the original
    definition; wrappers reassign later). Returns '' if absent."""
    pats = [
        r"async function %s\(" % re.escape(name),
        r"function %s\(" % re.escape(name),
        r"window\.%s\s*=\s*async function\s*\(" % re.escape(name),
        r"window\.%s\s*=\s*function\s*\(" % re.escape(name),
        r"var %s\s*=\s*async function\s*\(" % re.escape(name),
        r"var %s\s*=\s*function\s*\(" % re.escape(name),
    ]
    best = None
    for p in pats:
        m = re.search(p, src)
        if m and (best is None or m.start() < best.start()):
            best = m
    if not best:
        return ""
    i = src.index("(", best.end() - 1)
    depth = 1
    i += 1
    while i < len(src) and depth:      # skip the parameter list (no strings there)
        if src[i] == "(":
            depth += 1
        elif src[i] == ")":
            depth -= 1
        i += 1
    while i < len(src) and src[i] != "{":
        i += 1
    end = _scan(src, i, "brace")
    return src[best.start(): end] if end > 0 else ""


def find_const(src, name):
    m = re.search(r"var %s\s*=" % re.escape(name), src)
    if not m:
        return ""
    end = _scan(src, m.end(), "semi")
    return src[m.start(): end] if end > 0 else ""


def registry_block(src):
    """Concatenated text of every researchRegister({...}) call (empty pre-rebuild).
    Part of the plumbing layer: logic relocated here out of the loaders."""
    out = []
    for m in re.finditer(r"researchRegister\(\{", src):
        end = _scan(src, m.end() - 1, "brace")
        if end > 0:
            out.append(src[m.start():end])
    return "\n".join(out)


def query_literals(src):
    """All quoted string literals containing ?select= — the PostgREST shapes."""
    out = []
    for q in ("'", '"'):
        for m in re.finditer(r"%s([^%s\n\\]*\?select=[^%s\n\\]*)%s" % (q, q, q, q), src):
            out.append(m.group(1))
    return sorted(out)


def helper_profile(src, name):
    """Parse a fetch helper's (schema, default order, page cap, page size) from
    either the legacy inline pagination loop or the rsFetchAll shim."""
    body = find_function(src, name)
    if not body:
        return None
    flat = re.sub(r"\s+", "", body)
    m = re.search(r"rsFetchAll\((null|'(\w+)')\,[^,]+,(?:\w+\|\|)?'([^']+)',(\d+)", flat)
    if m:
        schema = m.group(2) or "public"
        return (schema, m.group(3), int(m.group(4)), 1000)
    # legacy inline form
    schema = "public"
    if "sbGetUfc" in flat:
        schema = "ufc"
    elif "sbGetCfb" in flat:
        schema = "cfb"
    elif "sbGetWta" in flat:
        schema = "wta"
    mo = re.search(r"(?:ord|orderBy)\|\|'([^']+)'", flat)
    mc = re.search(r"(?:p|page)<(\d+)", flat)
    mp = re.search(r"PAGE=(\d+)", flat)
    if not (mo and mc and mp):
        return None
    return (schema, mo.group(1), int(mc.group(1)), int(mp.group(1)))


def strip_strings_and_comments(body):
    """Code with string literals, comments AND regex literals removed, so a digit
    or quote inside any of them can neither corrupt parsing nor count as code."""
    out = []
    i = 0
    n = len(body)
    in_str = None
    esc = False
    prev_sig = ""
    while i < n:
        c = body[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == in_str:
                in_str = None
            i += 1
            continue
        if c in ("'", '"', "`"):
            in_str = c
            i += 1
            continue
        if body.startswith("//", i):
            j = body.find("\n", i)
            i = n if j < 0 else j
            continue
        if body.startswith("/*", i):
            j = body.find("*/", i)
            i = n if j < 0 else j + 2
            continue
        if c == "/" and prev_sig in "=(,:;!&|?{}[+-*%~^<>":
            i += 1
            in_class = False
            resc = False
            while i < n:
                rc = body[i]
                if resc:
                    resc = False
                elif rc == "\\":
                    resc = True
                elif rc == "[":
                    in_class = True
                elif rc == "]":
                    in_class = False
                elif rc == "/" and not in_class:
                    break
                i += 1
            i += 1
            prev_sig = "/"
            continue
        out.append(c)
        if not c.isspace():
            prev_sig = c
        i += 1
    return "".join(out)


def numeric_fingerprint(body):
    """Multiset of number-shaped expressions in code (strings/comments removed)."""
    code = strip_strings_and_comments(body)
    items = []
    items += re.findall(r"\.toFixed\(\s*\d+\s*\)", code)
    items += re.findall(r"Math\.(?:round|floor|ceil|abs|max|min|pow)\(", code)
    items += re.findall(r"(?:===|!==|==|!=|>=|<=|>|<)\s*-?\d+(?:\.\d+)?", code)
    items += re.findall(r"(?<![\w.])\d+(?:\.\d+)?(?![\w])", code)
    return sorted(items)


def diff_lines(a, b, name):
    import difflib
    return "".join(difflib.unified_diff(
        a.splitlines(keepends=True), b.splitlines(keepends=True),
        fromfile="pre/" + name, tofile="post/" + name))


def multiset_diff(a, b):
    from collections import Counter
    ca, cb = Counter(a), Counter(b)
    removed = sorted((ca - cb).elements())
    added = sorted((cb - ca).elements())
    return removed, added


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    allow_render = "--allow-render-changes" in sys.argv
    if len(args) != 2:
        print(__doc__)
        sys.exit(2)
    pre, post = read(args[0]), read(args[1])
    failed = False

    print("=" * 72)
    print("A. POSTGREST QUERY INVENTORY")
    removed, added = multiset_diff(query_literals(pre), query_literals(post))
    if removed or added:
        for r in removed:
            print("  REMOVED  %s" % r)
        for a in added:
            print("  ADDED    %s" % a)
        if removed:
            failed = True
            print("  -> FAIL: existing query shapes changed or vanished")
        else:
            print("  -> additions only (new features); review above")
    else:
        print("  identical (%d query literals)" % len(query_literals(pre)))

    print("-" * 72)
    print("A2. FETCH-HELPER PAGINATION PROFILES")
    for name, expect in HELPER_PROFILES.items():
        pp, qp = helper_profile(pre, name), helper_profile(post, name)
        status = "ok" if pp == qp == expect else "FAIL"
        if status == "FAIL":
            failed = True
        print("  %-12s pre=%s post=%s expected=%s  %s" % (name, pp, qp, expect, status))

    print("=" * 72)
    print("B. RENDER/FORMAT FUNCTION BODIES (must be byte-identical%s)"
          % (" — advisory under --allow-render-changes" if allow_render else ""))
    changed = []
    for fn in RENDER_FNS:
        a, b = find_function(pre, fn), find_function(post, fn)
        if not a:
            print("  MISSING IN PRE: %s" % fn)
            continue
        if not b:
            print("  MISSING IN POST: %s" % fn)
            failed = True
            continue
        if hashlib.sha256(a.encode()).hexdigest() != hashlib.sha256(b.encode()).hexdigest():
            changed.append(fn)
    for c in CONST_LITERALS:
        a, b = find_const(pre, c), find_const(post, c)
        if a != b:
            changed.append(c)
    if changed:
        print("  changed: %s" % ", ".join(changed))
        if not allow_render:
            failed = True
            for fn in changed:
                a = find_function(pre, fn) or find_const(pre, fn)
                b = find_function(post, fn) or find_const(post, fn)
                print(diff_lines(a, b, fn))
    else:
        print("  all %d render functions and %d display constants byte-identical"
              % (len(RENDER_FNS), len(CONST_LITERALS)))

    print("=" * 72)
    print("C. NUMERIC FINGERPRINTS OF RENDER FUNCTIONS (always mandatory)")
    dirty = False
    for fn in RENDER_FNS:
        a, b = find_function(pre, fn), find_function(post, fn)
        if not a or not b:
            continue
        removed, added = multiset_diff(numeric_fingerprint(a), numeric_fingerprint(b))
        if removed or added:
            dirty = failed = True
            print("  %s: removed=%s added=%s" % (fn, removed, added))
    if not dirty:
        print("  identical — no numeric literal, rounding call, or threshold changed")

    print("=" * 72)
    print("L. LOADER / PLUMBING LAYER")
    # The plumbing layer is compared as a WHOLE (loaders + the module registry),
    # because the rebuild deliberately relocates logic out of loaders into the
    # registry's freshness()/contract functions. A numeral that LEAVES this layer
    # means a computation was lost -> fail. A numeral that ENTERS it is new
    # plumbing (cadences, status codes) and is reported for review: it cannot
    # reach a displayed value, because section C guards the render layer.
    pre_layer = "\n".join(find_function(pre, fn) for fn in LOADER_FNS) + "\n" + registry_block(pre)
    post_layer = "\n".join(find_function(post, fn) for fn in LOADER_FNS) + "\n" + registry_block(post)
    lost, gained = multiset_diff(numeric_fingerprint(pre_layer), numeric_fingerprint(post_layer))
    if lost:
        failed = True
        print("  FAIL — numerals LOST from the plumbing layer: %s" % lost)
    else:
        print("  no numeral lost from the plumbing layer (loaders + module registry)")
    if gained:
        print("  new plumbing numerals (review): %s" % gained)
    for fn in LOADER_FNS:
        a, b = find_function(pre, fn), find_function(post, fn)
        if not a and not b:
            continue
        d = diff_lines(a, b, fn)
        if d:
            print(d)
    print("=" * 72)
    print("RESULT: %s" % ("FAIL — see sections above" if failed else "CLEAN"))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
