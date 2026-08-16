#!/usr/bin/env python3
"""
Anchor-verified patcher for supabase/functions/edgedesk_ai/index.ts.

WHY A PATCHER AND NOT A REWRITTEN FILE
The edge function is ~4,000 lines of production pricing/research code. Every fix
below touches a handful of lines; the other 99.8% of the file must come through
byte-identical. Reproducing the whole file by hand to change twelve places is a
silent-corruption risk in code that decides what a bettor is told, so this walks
the original instead and refuses to write unless every anchor matches EXACTLY
ONCE. A moved or already-patched anchor is a hard error, never a quiet skip.

    python3 tools/patch-edgedesk-ai.py --check  path/to/index.ts
    python3 tools/patch-edgedesk-ai.py --write  path/to/index.ts
    python3 tools/patch-edgedesk-ai.py --selftest

--write leaves the original at <file>.orig before touching anything.
"""

import argparse
import shutil
import sys

# (id, one-line summary, anchor, replacement)
FIXES = [

    # ------------------------------------------------------------------ 1
    ("movement-uses-frozen-price",
     "movementRead was handed the CURRENT price as the 'frozen entry' price, so it "
     "compared now against now and reported 'flat' on essentially every signal.",
     """    const mv = await dal.getLineMovement(sigKey);
    evidence.push(...mv);
    const series = (mv[0]?.value as any)?.series ?? null;
    movement = movementRead(num(focus.best_dec), series);""",
     """    const mv = await dal.getLineMovement(sigKey);
    evidence.push(...mv);
    const series = (mv[0]?.value as any)?.series ?? null;
    /* THE FROZEN PRICE, NOT THE CURRENT ONE. movementRead measures the detection
       price against the latest tick — that is the whole question it answers. It
       was being passed best_dec, which IS the latest price, so entry and last
       were the same number and the function returned "flat" on essentially
       every signal while its own note claimed the market had not moved. The
       frozen number is first_best_dec, which getSlate already selects; best_dec
       remains the fallback for a row that predates detection capture. */
    movement = movementRead(num(focus.first_best_dec) ?? num(focus.best_dec), series);"""),

    # ------------------------------------------------------------------ 2a
    ("calibration-type",
     "ResearchOut.memory had no calibration field, so the fetched calibration rows "
     "had nowhere to live.",
     """  memory: { facts: any[]; outcomes: any[]; patterns: any[]; prior: any[] };""",
     """  memory: { facts: any[]; outcomes: any[]; patterns: any[]; prior: any[]; calibration: any[] };"""),

    # ------------------------------------------------------------------ 2b
    ("calibration-init",
     "memory initializer needs the calibration slot.",
     """  let memory = { facts: [] as any[], outcomes: [] as any[], patterns: [] as any[], prior: [] as any[] };""",
     """  let memory = { facts: [] as any[], outcomes: [] as any[], patterns: [] as any[], prior: [] as any[],
                 calibration: [] as any[] };"""),

    # ------------------------------------------------------------------ 2c
    ("calibration-carried",
     "getResearchMemory returns calibration and it was dropped on assignment, so the "
     "CALIBRATION section of the system prompt could never fire.",
     """    memory = { facts: m.facts, outcomes: m.outcomes, patterns: m.patterns, prior: m.prior };""",
     """    /* CALIBRATION WAS FETCHED AND THEN THROWN AWAY. getResearchMemory reads
       research_calibration — a real query against the retrieval budget — and
       this assignment dropped the field on the floor. Downstream,
       `(mem as any).calibration ?? []` therefore evaluated to [] on every turn,
       so the whole CALIBRATION section of the system prompt was unreachable and
       the one measurement that says what a quoted edge has historically been
       WORTH never reached the analyst. */
    memory = { facts: m.facts, outcomes: m.outcomes, patterns: m.patterns, prior: m.prior,
               calibration: m.calibration };"""),

    # ------------------------------------------------------------------ 3a
    ("research-thresholds",
     "The research layer hardcoded a 2% floor and 45m staleness while the deterministic "
     "engine ships 0.5% and 90m — so the AI contradicted the board.",
     """// When the owned MLB feature tables are empty, fall back to the official MLB
// Stats API for the traditional pitching line. Set to "0" to keep the engine
// strictly on owned tables and report the gap instead.
const MLB_FALLBACK = (Deno.env.get("EDGEDESK_MLB_FALLBACK") ?? "1") !== "0";""",
     """// When the owned MLB feature tables are empty, fall back to the official MLB
// Stats API for the traditional pitching line. Set to "0" to keep the engine
// strictly on owned tables and report the gap instead.
const MLB_FALLBACK = (Deno.env.get("EDGEDESK_MLB_FALLBACK") ?? "1") !== "0";

/* ── THE SAME FLOOR AND THE SAME CLOCK AS THE DETERMINISTIC ENGINE ────────
   attackThesis, crossMarketFlags and scout each carried their own default
   floor of 0.02 and staleness of 45 minutes. The browser engine ships
   REAL_FLOOR = 0.005 and EDGE_MAX_AGE_MIN = 90. Nothing reconciled the two, so
   this layer would call a 1.2% edge "INVALIDATED — below the 2.0% floor" and
   a 50-minute-old quote stale, while the board beside it showed the same
   signal as a live LEAN. Two halves of one product disagreeing about the same
   number is worse than either being wrong alone, because the user cannot tell
   which to believe.
   Defaults track the engine; the env vars exist so both halves can be moved
   together rather than drifting apart again. */
const RESEARCH_FLOOR = Number(Deno.env.get("EDGEDESK_REAL_FLOOR") ?? "0.005");
const RESEARCH_STALE_MIN = Number(Deno.env.get("EDGEDESK_EDGE_MAX_AGE_MIN") ?? "90");"""),

    # ------------------------------------------------------------------ 3b
    ("attack-uses-engine-floor",
     "attackThesis called with its 2%/45m defaults.",
     """  const attack = focus ? attackThesis(focus) : null;""",
     """  const attack = focus ? attackThesis(focus, RESEARCH_FLOOR, RESEARCH_STALE_MIN) : null;"""),

    # ------------------------------------------------------------------ 3c
    ("cross-market-uses-engine-floor",
     "crossMarketFlags called with its 2% default, so it ignored every edge between "
     "0.5% and 2% that the board considers playable.",
     """    cross = crossMarketFlags(cm.rows);""",
     """    cross = crossMarketFlags(cm.rows, RESEARCH_FLOOR);"""),

    # ------------------------------------------------------------------ 3d
    ("scout-uses-engine-floor",
     "scout called with its 2%/45m defaults.",
     """  const queue = slateRows.length ? scout(slateRows) : [];""",
     """  const queue = slateRows.length ? scout(slateRows, RESEARCH_FLOOR, RESEARCH_STALE_MIN) : [];"""),

    # ------------------------------------------------------------------ 4
    ("slate-tradeable-filter",
     "The tradeability filter kept the rows it had just rejected whenever ALL of them "
     "failed, and the rejection reasons were collected and discarded.",
     """    const _drop: string[] = [];
    const _clean = rows.filter((r: any) => { const t = signalTradeable(r); if (!t.ok) _drop.push(t.reason!); return t.ok; });
    if (_clean.length) rows = _clean;
    const out = rows.map((r) => ev({
      source: "signals", entity: `${r.away_team} @ ${r.home_team}`, field: "signal",
      value: r, status: "VERIFIED", relevance: "market",
      source_timestamp: r.last_seen_at, freshness: freshnessOf("odds", r.last_seen_at),
    }));
    return { rows, ev: out };""",
     """    /* A FILTER THAT KEEPS WHAT IT REJECTED IS NOT A FILTER. `if (_clean.length)`
       meant that when EVERY row failed the tradeable bound — an exchange-lay
       feed, a placeholder-price run, a bad capture — all of them were passed
       through unchanged and priced as though they were real markets. And
       `_drop` collected the reason for each rejection and was then discarded,
       so nothing downstream could report that a single row had been dropped.
       Both halves are fixed here: the filter always applies, and what it
       removed becomes visible evidence rather than a silent deletion. */
    const _drop: string[] = [];
    const _clean = rows.filter((r: any) => { const t = signalTradeable(r); if (!t.ok) _drop.push(t.reason!); return t.ok; });
    const _dropped = rows.length - _clean.length;
    const _why = Array.from(new Set(_drop)).slice(0, 4).join("; ");
    rows = _clean;
    if (!rows.length) {
      return { rows: [], ev: [unavailable("signals", "slate",
        `all ${_dropped} signal rows in the window failed the tradeable bound (${_why}). `
        + `That is a capture problem, not an empty board — do not describe the slate as quiet.`)] };
    }
    const out = rows.map((r) => ev({
      source: "signals", entity: `${r.away_team} @ ${r.home_team}`, field: "signal",
      value: r, status: "VERIFIED", relevance: "market",
      source_timestamp: r.last_seen_at, freshness: freshnessOf("odds", r.last_seen_at),
    }));
    if (_dropped) {
      out.push(ev({
        source: "signals", entity: null, field: "slate_filtered", relevance: "market",
        value: { dropped: _dropped, kept: rows.length, reasons: Array.from(new Set(_drop)).slice(0, 8) },
        status: "PARTIAL", freshness: "CURRENT",
        note: `${_dropped} row(s) were removed as untradeable before anything was ranked (${_why}). `
          + `The board you are reading is ${rows.length} rows, not ${rows.length + _dropped}.`,
      }));
    }
    return { rows, ev: out };"""),

    # ------------------------------------------------------------------ 5a
    ("mode-of-intent-helper",
     "MODE_OF_INTENT registers 23 intents but the NFL/CFB/CBB modules can emit 62 more, "
     "so those questions reported mode FAST while running a SLATE/DEEP plan.",
     """  full_research: "DEEP", why: "FAST", unknown: "FAST",
};""",
     """  full_research: "DEEP", why: "FAST", unknown: "FAST",
};

/**
 * The mode for an intent, including the ones the sport modules added.
 *
 * MODE_OF_INTENT was written before the NFL, CFB and CBB modules introduced
 * their own intents. It registers 23 keys; those modules can emit 62 more, and
 * not one of them was added — so every one of those questions fell through
 * `?? "FAST"` and reported mode=FAST in the research trace
 * while executing a SLATE or DEEP retrieval plan. The label is what the research
 * trace shows the user and what `plan.mode === "SCOUT"` gates the research queue
 * on, so a wrong one is a wrong story about what the engine just did.
 *
 * Derived from the intent's own shape rather than restated per sport, so a new
 * `xyz_best_matchups` is classified correctly the day it is added.
 */
export function modeOfIntent(intent: string): Mode {
  const m = MODE_OF_INTENT[intent];
  if (m) return m;
  if (/_what_changed$/.test(intent)) return "MARKET";
  if (/_historical(_matchup)?$/.test(intent)) return "HISTORICAL";
  if (/_comparison$/.test(intent)) return "COMPARE";
  if (/_betting_candidate$/.test(intent)) return "SLATE";
  if (/_injury_impact$|_availability$|_roster$|_returning_production$|_portal$/.test(intent)) return "DEEP";
  if (/_(matchups?|offenses|defenses|quarterbacks|teams|players|sp_plus|recruiting)$/.test(intent)) return "MATCHUP";
  if (/^(nfl|cfb|cbb)_/.test(intent)) return "DEEP";
  return "FAST";
}"""),

    # ------------------------------------------------------------------ 5b
    ("plan-uses-mode-helper",
     "classify() still looked the mode up directly.",
     """    intent, mode: MODE_OF_INTENT[intent] ?? "FAST", depth, sport: null, steps, entities,""",
     """    intent, mode: modeOfIntent(intent), depth, sport: null, steps, entities,"""),

    # ------------------------------------------------------------------ 6
    ("slate-budget",
     "SLATE had a SMALLER retrieval budget (12) than DEEP (14) despite issuing far more "
     "reads, so slate questions ran out of budget mid-retrieval.",
     """    budget: depth === "QUICK" ? 4 : depth === "STANDARD" ? 8 : depth === "DEEP" ? 14 : depth === "SLATE" ? 12 : 18,""",
     """    /* SLATE was given 12 reads — FEWER than DEEP's 14 — while being the depth
       that retrieves the most: board, card, the three-table pitcher join,
       usage, season pitching, season offense, bullpen, weather, CLV history
       plus its exact count, and then whatever the adaptive second pass needs.
       That is ~13 before a single probe or fallback, so a full MLB slate
       reliably hit "research budget exhausted before this read" partway
       through and the analyst reported the tail of the card as missing data.
       A slate sweep is the widest thing this engine does and is budgeted as
       such; QUICK and STANDARD are untouched, so a cheap question stays cheap. */
    budget: depth === "QUICK" ? 4 : depth === "STANDARD" ? 8 : depth === "DEEP" ? 14 : depth === "SLATE" ? 20 : 24,"""),
]


def apply_all(src: str):
    """Returns (patched, applied, problems). Never partially applies on error."""
    out, applied, problems = src, [], []
    for fid, summary, anchor, repl in FIXES:
        # The signature is checked BEFORE the anchor, not as an explanation for a
        # miss. Several fixes are insertions: the replacement CONTAINS the anchor
        # verbatim and appends to it. For those the anchor still matches after a
        # successful run, so an anchor-first design would happily insert the same
        # block a second time and produce a file with two `const RESEARCH_FLOOR`
        # declarations. Signature-first makes every fix idempotent by the same
        # rule, whether it replaces text or adds to it.
        if _already(out, fid, repl):
            problems.append((fid, "ALREADY APPLIED", summary))
            continue
        n = out.count(anchor)
        if n == 1:
            out = out.replace(anchor, repl, 1)
            applied.append((fid, summary))
        elif n == 0:
            problems.append((fid, "ANCHOR NOT FOUND", summary))
        else:
            problems.append((fid, f"ANCHOR MATCHED {n} TIMES — ambiguous, refusing", summary))
    return out, applied, problems


def _already(src: str, fid: str, repl: str) -> bool:
    """A cheap signature per fix so a re-run reports 'already applied', not 'missing'."""
    sig = {
        "movement-uses-frozen-price": "num(focus.first_best_dec) ?? num(focus.best_dec)",
        "calibration-type": "prior: any[]; calibration: any[] }",
        "calibration-init": "calibration: [] as any[]",
        "calibration-carried": "calibration: m.calibration",
        "research-thresholds": "const RESEARCH_FLOOR",
        "attack-uses-engine-floor": "attackThesis(focus, RESEARCH_FLOOR",
        "cross-market-uses-engine-floor": "crossMarketFlags(cm.rows, RESEARCH_FLOOR)",
        "scout-uses-engine-floor": "scout(slateRows, RESEARCH_FLOOR",
        "slate-tradeable-filter": "field: \"slate_filtered\"",
        "mode-of-intent-helper": "export function modeOfIntent",
        "plan-uses-mode-helper": "mode: modeOfIntent(intent)",
        "slate-budget": '"SLATE" ? 20 : 24',
    }.get(fid)
    return bool(sig) and sig in src


def main() -> int:
    ap = argparse.ArgumentParser(description="Patch edgedesk_ai/index.ts")
    ap.add_argument("file", nargs="?", help="path to index.ts")
    ap.add_argument("--write", action="store_true", help="apply the fixes in place")
    ap.add_argument("--check", action="store_true", help="report without writing (default)")
    ap.add_argument("--selftest", action="store_true", help="run against built-in fixtures")
    a = ap.parse_args()

    if a.selftest:
        return selftest()
    if not a.file:
        ap.error("a file path is required unless --selftest is used")

    src = open(a.file, encoding="utf-8").read()
    out, applied, problems = apply_all(src)

    for fid, summary in applied:
        print(f"  OK      {fid}\n            {summary}")
    for fid, why, summary in problems:
        print(f"  {why:<24} {fid}\n            {summary}")

    print(f"\n{len(applied)}/{len(FIXES)} fixes apply cleanly.")
    if problems and any(w == "ANCHOR NOT FOUND" or w.startswith("ANCHOR MATCHED") for _, w, _ in problems):
        print("Refusing to write: at least one anchor did not match exactly once.")
        print("That means the file differs from the reviewed version — reconcile by hand rather than forcing it.")
        return 2
    if a.write:
        shutil.copyfile(a.file, a.file + ".orig")
        open(a.file, "w", encoding="utf-8").write(out)
        print(f"Written. Original preserved at {a.file}.orig")
    else:
        print("Dry run only. Re-run with --write to apply.")
    return 0


def selftest() -> int:
    """Every anchor is exercised against a fixture built from the reviewed source."""
    fixture = "\n\n".join(anchor for _, _, anchor, _ in FIXES)
    out, applied, problems = apply_all(fixture)
    for fid, why, summary in problems:
        print(f"  FAIL {fid}: {why}")
    ok = len(applied) == len(FIXES) and not problems
    # A second pass must be a clean no-op that reports "already applied".
    _, applied2, problems2 = apply_all(out)
    reapplied = [f for f, _ in applied2]
    if reapplied:
        print(f"  FAIL re-running the patcher re-applied: {reapplied}")
        ok = False
    if not all(w == "ALREADY APPLIED" for _, w, _ in problems2):
        print("  FAIL a second pass did not report every fix as already applied:")
        for fid, why, _ in problems2:
            if why != "ALREADY APPLIED":
                print(f"       {fid}: {why}")
        ok = False
    print(f"selftest: {len(applied)}/{len(FIXES)} anchors matched exactly once; "
          f"re-run is idempotent: {'yes' if not reapplied else 'NO'}")
    print("ALL GREEN" if ok else "FAILURES")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
