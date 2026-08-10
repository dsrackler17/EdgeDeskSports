// Tests for the multisport ingest helpers. No database, no network, no key.
//   node --experimental-strip-types --import ../_testkit/register.mjs ingest_multisport/test.ts
import {
  num, parseCsv, col, normTeam, restDays, torvikRow, nflverseRow, anyValue,
  espnDate, SPORTS, BUILD, torvikExtras, defenceFromWeekly,
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

  /* The REAL nflverse header set, taken from a live probe. The file is season
     TOTALS, not rates — the first version of this mapping looked for
     off_epa_play and def_epa_play and would have found neither. */
  const nflReal = {
    season: "2025", team: "BUF", season_type: "REG", games: "17",
    completions: "380", attempts: "560", passing_yards: "4200", passing_tds: "32",
    passing_interceptions: "9", sacks_suffered: "28", passing_epa: "112.5", passing_cpoe: "3.1",
    carries: "440", rushing_yards: "2100", rushing_epa: "18.4",
    penalties: "95", penalty_yards: "780",
    def_sacks: "44", def_qb_hits: "96", def_tackles_for_loss: "70",
    def_interceptions: "16", def_pass_defended: "70", fumble_recovery_opp: "8",
    fumbles_lost_total: "7",
  };
  const n = nflverseRow(nflReal);
  // 560 attempts + 28 sacks + 440 carries = 1028 plays; (112.5 + 18.4) / 1028
  eq("F7 offensive EPA per play is DERIVED from season totals", n.off_epa_play, 0.1273);
  eq("F8 pass EPA is per DROPBACK — attempts plus sacks", n.pass_epa_play, 0.1913);
  eq("F9 rush EPA is per carry", n.rush_epa_play, 0.0418);
  eq("F10 plays per game comes from the same denominator", n.plays_per_game, 60.4706);
  eq("F11 sack rate allowed is sacks over dropbacks", n.sack_rate_allowed, 0.0476);
  // takeaways 16+8=24, giveaways 9+7=16, margin +8 over 17 games
  eq("F12 turnover margin is takeaways minus giveaways, per game", n.turnover_margin_pg, 0.4706);

  /* The columns this feed genuinely does not carry. Naming them is the point:
     a disruption proxy dressed as an efficiency number is the substitution
     that makes a model look predictive and behave randomly. */
  eq("F13 defensive EPA is NOT invented from sacks", n.def_epa_play, null);
  eq("F14 nor is success rate", [n.off_success_rate, n.def_success_rate], [null, null]);
  eq("F15 nor explosive rate", n.explosive_play_rate, null);
  ok("F16 defensive counting stats are kept as CONTEXT, not efficiency",
    (n as any).__metrics.def_sacks_pg === 2.5882 && (n as any).__metrics.takeaways_pg === 1.4118);
  ok("F17 ...and say so in their own note",
    /NOT an efficiency measure/.test((n as any).__metrics.note));

  eq("F18 a row with no games cannot produce per-game rates",
    nflverseRow({ attempts: "100", passing_epa: "10" }).plays_per_game, null);
  eq("F19 zero plays never divides by zero",
    nflverseRow({ games: "0", attempts: "0", carries: "0", passing_epa: "0" }).off_epa_play, null);

  /* The REAL Torvik season-results header set, also from a live probe. It
     carries adjusted efficiency and tempo but NOT the four factors, which live
     in the trank leaderboard. */
  const torvikReal = {
    rank: "1", team: "Duke", conf: "ACC", record: "28-4",
    adjoe: "121.4", "oe Rank": "2", adjde: "89.7", "de Rank": "3",
    barthag: "0.9712", sos: "58.4", ncsos: "62.1",
    "Opp OE": "104.2", "Opp DE": "101.8", WAB: "8.4", adjt: "67.3",
  };
  const t2 = torvikRow(torvikReal);
  eq("F20 adjusted offence from the real header", t2.adj_o, 121.4);
  eq("F21 adjusted defence", t2.adj_d, 89.7);
  eq("F22 tempo is 'adjt' in this file, not 'adj_t'", t2.adj_tempo, 67.3);
  eq("F23 wins above bubble is matched case-insensitively", t2.wab, 8.4);
  eq("F24 the four factors are genuinely absent from this file",
    [t2.efg_pct, t2.to_pct, t2.orb_pct, t2.ft_rate], [null, null, null, null]);

  const x = torvikExtras(torvikReal);
  eq("F25 barthag is kept as context", x.barthag, 0.9712);
  eq("F26 ...along with schedule strength", [x.sos, x.ncsos], [58.4, 62.1]);
  eq("F27 ...and the conference", x.conf, "ACC");
  ok("F28 ...with a note saying where the four factors actually live",
    /trank leaderboard/.test(x.note));

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
    typeof BUILD === "string" && /^\d{4}-\d{2}-\d{2}\.\d+-/.test(BUILD), BUILD);
}

/* Defensive EPA is the biggest hole in the NFL layer, and it is closable
   without a new source: in any game one team's offensive EPA IS the other's
   defensive EPA allowed. Weekly rows with an opponent column give a season of
   defence from a season of offence, exactly, with no proxy. */
sec("Defence is derived from offence, exactly");
{
  // Two games. BUF's offence is what MIA's defence allowed, and vice versa.
  const weekly = [
    { week: "1", team: "BUF", opponent_team: "MIA", attempts: "30", carries: "20",
      sacks_suffered: "0", passing_epa: "10", rushing_epa: "5" },
    { week: "1", team: "MIA", opponent_team: "BUF", attempts: "40", carries: "10",
      sacks_suffered: "0", passing_epa: "-5", rushing_epa: "0" },
    { week: "2", team: "BUF", opponent_team: "NYJ", attempts: "30", carries: "20",
      sacks_suffered: "0", passing_epa: "20", rushing_epa: "5" },
  ];
  const d = defenceFromWeekly(weekly);

  // MIA allowed BUF's week-1 line: 15 EPA over 50 plays.
  eq("D1 a defence's EPA allowed is its opponents' offensive EPA",
    d.byTeam.get("mia")!.def_epa_play, 0.3);
  // BUF allowed MIA's week-1 line: -5 EPA over 50 plays. Negative is good.
  eq("D2 ...and keeps the sign, where negative is a good defence",
    d.byTeam.get("buf")!.def_epa_play, -0.1);
  eq("D3 pass defence uses dropbacks as the denominator",
    d.byTeam.get("buf")!.def_pass_epa_play, -0.125);
  eq("D4 rush defence uses carries", d.byTeam.get("buf")!.def_rush_epa_play, 0);
  // NYJ appears only as an opponent and still gets a defensive line.
  eq("D5 a team seen only as an opponent still gets a defence",
    d.byTeam.get("nyj")!.def_epa_play, 0.5);
  eq("D6 games allowed are counted per defence",
    [d.byTeam.get("buf")!.games, d.byTeam.get("mia")!.games], [1, 1]);
  eq("D7 every usable row is paired", d.paired, 3);

  // Rows that cannot be attributed are skipped, never guessed at.
  const messy = defenceFromWeekly([
    { week: "1", team: "BUF", attempts: "30", carries: "20", passing_epa: "10" },
    { week: "1", team: "BUF", opponent_team: "MIA", attempts: "0", carries: "0", passing_epa: "10" },
  ]);
  eq("D8 a row with no opponent cannot be attributed and is skipped", messy.orphaned, 2);
  eq("D9 ...and produces no defensive line at all", messy.byTeam.size, 0);
  eq("D10 an empty season is empty, not a crash", defenceFromWeekly([]).byTeam.size, 0);

  // Sacks belong in the dropback denominator on the defensive side too.
  const withSacks = defenceFromWeekly([
    { week: "1", team: "BUF", opponent_team: "MIA", attempts: "30", carries: "20",
      sacks_suffered: "5", passing_epa: "-7", rushing_epa: "0" },
  ]);
  eq("D11 a sack counts as a dropback the defence forced",
    withSacks.byTeam.get("mia")!.def_pass_epa_play, -0.2);
  eq("D12 ...and as a play in the overall rate",
    withSacks.byTeam.get("mia")!.def_epa_play, -0.1273);
}

console.log(`\n${failed === 0 ? "ALL GREEN" : "FAILURES"} — ${passed} passed, ${failed} failed`);
if (failures.length) console.log("failed:", failures.join(" | "));
if (typeof process !== "undefined" && failed > 0) (process as any).exit(1);
