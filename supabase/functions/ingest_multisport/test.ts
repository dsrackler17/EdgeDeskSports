// Tests for the multisport ingest helpers. No database, no network, no key.
//   node --experimental-strip-types --import ../_testkit/register.mjs ingest_multisport/test.ts
import {
  num, parseCsv, col, normTeam, restDays, torvikRow, nflverseRow, anyValue,
  espnDate, SPORTS, BUILD,
} from "./index.ts";

let passed = 0, failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`); }
}
function eq(name: string, got: unknown, want: unknown) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
}
function sec(s: string) { console.log(`\n${s}`); }

sec("CSV parsing, with the quote bug that cost a week on the MLB side");
{
  const rows = parseCsv('team,adjoe,adjde\n"Duke","118.2","92.4"\nKansas,114.0,95.1');
  eq("C1 two rows", rows.length, 2);
  eq("C2 quotes are stripped from HEADERS", Object.keys(rows[0]).sort(), ["adjde", "adjoe", "team"]);
  /* The actual bug: quotes stripped from headers but not values, so
     parseFloat('"118.2"') was NaN and the stat vanished silently. */
  eq("C3 ...and from VALUES, so the number survives", num(rows[0].adjoe), 118.2);
  eq("C4 unquoted rows parse identically", num(rows[1].adjde), 95.1);
  eq("C5 an empty document is empty, not a crash", parseCsv(""), []);
  eq("C6 a header with no rows yields nothing", parseCsv("a,b,c"), []);
  const emb = parseCsv('team,note\n"St. John\'s","a, b"');
  eq("C7 a comma inside quotes does not split the field", emb[0].note, "a, b");
}

sec("Column lookup refuses derived-difference headers");
{
  /* The ingest_mlb bug, kept fixed: a fuzzy-first lookup for `xera` matched
     `era_minus_xera_diff` whenever the real cell was blank, storing a -0.62
     difference as an expected ERA. */
  const row = { xera: "", era_minus_xera_diff: "-0.62", adjoe: "118.2" };
  eq("K1 a blank exact match does NOT fall through to a _diff column",
    col(row, ["xera"]), null);
  eq("K2 a populated exact match wins", col(row, ["adjoe"]), 118.2);
  eq("K3 case and punctuation are tolerated in the fuzzy pass",
    col({ AdjOE: "115.5" }, ["adjoe"]), 115.5);
  eq("K4 the first name in the list wins",
    col({ adj_o: "1", adjoe: "2" }, ["adj_o", "adjoe"]), 1);
  eq("K5 nothing found is null, never zero", col({ a: "1" }, ["b"]), null);
  eq("K6 a percent sign is stripped", col({ efg: "55.1%" }, ["efg"]), 55.1);
}

sec("Team-name normalisation across two feeds");
{
  eq("N1 ESPN and Torvik forms of the same school converge",
    normTeam("Ohio St."), normTeam("Ohio State"));
  /* Two feeds will spell this school both ways; an apostrophe must not split
     the word or the join misses silently. */
  eq("N2 an apostrophe does not split a name",
    normTeam("St. John's"), normTeam("St Johns"));
  eq("N2b ...and a curly apostrophe matches a straight one",
    normTeam("St. John\u2019s"), normTeam("St. John's"));
  eq("N3 an ampersand becomes a word", normTeam("Texas A&M"), "texas a and m");
  eq("N4 'University' is dropped", normTeam("Duke University"), "duke");
  eq("N5 an empty name is empty, not a crash", normTeam(null), "");
  ok("N6 two genuinely different schools do NOT collide",
    normTeam("Miami (OH)") !== normTeam("Miami (FL)"));
}

sec("Rest days");
{
  eq("R1 a normal NFL week", restDays("2026-09-13T17:00:00Z", "2026-09-20T17:00:00Z"), 7);
  // Sunday 1pm ET kickoff to Thursday 8:20pm ET kickoff.
  eq("R2 a Thursday short week", restDays("2026-09-13T17:00:00Z", "2026-09-18T00:20:00Z"), 4);
  eq("R3 back-to-back nights in college basketball",
    restDays("2026-12-01T00:00:00Z", "2026-12-02T00:00:00Z"), 1);
  eq("R4 no prior game means no rest figure", restDays(null, "2026-09-20T17:00:00Z"), null);
  eq("R5 an unparseable date is null, not NaN", restDays("soon", "2026-09-20T17:00:00Z"), null);
  eq("R6 an absurd gap is refused rather than reported",
    restDays("2025-01-01T00:00:00Z", "2026-09-20T17:00:00Z"), null);
}

sec("Feed row mapping");
{
  const t = torvikRow({ adjoe: "118.2", adjde: "92.4", adj_t: "66.1", efg_o: "55.1", efg_d: "45.0", to_o: "15.2" });
  eq("F1 adjusted offence", t.adj_o, 118.2);
  eq("F2 adjusted defence", t.adj_d, 92.4);
  eq("F3 tempo", t.adj_tempo, 66.1);
  eq("F4 four factors are read for BOTH ends", [t.efg_pct, t.def_efg_pct], [55.1, 45.0]);
  eq("F5 a column the feed omits is null, not zero", t.wab, null);
  ok("F6 a recognised row reports that it found something", anyValue(t));

  const n = nflverseRow({ off_epa_play: "0.14", def_epa_play: "-0.06", off_success_rate: "0.49" });
  eq("F7 offensive EPA", n.off_epa_play, 0.14);
  eq("F8 defensive EPA keeps its sign — negative is a good defence", n.def_epa_play, -0.06);
  eq("F9 success rate", n.off_success_rate, 0.49);

  /* An entirely unrecognised shape must be detectable, because that is what a
     feed looks like the day it changes its headers. */
  ok("F10 an unrecognised row reports that it found NOTHING",
    !anyValue(torvikRow({ some_other_header: "1" })));
  ok("F11 ...and an HTML page parsed as CSV is equally empty",
    !anyValue(torvikRow({ "<!DOCTYPE html>": "" })));
}

sec("Sport definitions and dates");
{
  eq("S1 three sports are wired", Object.keys(SPORTS).sort(), ["cbb", "cfb", "nfl"]);
  eq("S2 each carries the sport_key `signals` uses",
    SPORTS.nfl.key + "|" + SPORTS.cfb.key + "|" + SPORTS.cbb.key,
    "americanfootball_nfl|americanfootball_ncaaf|basketball_ncaab");
  eq("S3 game_id prefixes are distinct, matching the MLB- convention",
    new Set(Object.values(SPORTS).map((s) => s.gamePrefix)).size, 3);
  eq("S4 basketball is not treated as football",
    [SPORTS.cbb.kind, SPORTS.nfl.kind, SPORTS.cfb.kind], ["basketball", "football", "football"]);
  eq("S5 ESPN wants YYYYMMDD", espnDate(new Date("2026-08-14T12:00:00Z")), "20260814");
  ok("S6 the build marker is set so a deploy can be confirmed",
    typeof BUILD === "string" && /offseason-aware/.test(BUILD), BUILD);
}

console.log(`\n${failed === 0 ? "ALL GREEN" : "FAILURES"} — ${passed} passed, ${failed} failed`);
if (failures.length) console.log("failed:", failures.join(" | "));
if (typeof process !== "undefined" && failed > 0) (process as any).exit(1);
