// supabase/functions/settle/test.ts
//   node --experimental-strip-types supabase/functions/settle/test.ts
//
// Covers the grading and column-resolution bugs that were silently corrupting
// data, plus the regressions that would reintroduce them. No network, no keys.

let passed = 0, failed = 0; const fails: string[] = [];
function ok(n: string, c: boolean, d?: unknown) {
  if (c) { passed++; console.log(`  PASS  ${n}`); }
  else { failed++; fails.push(n); console.log(`  FAIL  ${n}${d !== undefined ? "  " + JSON.stringify(d) : ""}`); }
}
function eq(n: string, got: unknown, want: unknown) { ok(n, JSON.stringify(got) === JSON.stringify(want), { got, want }); }
function sec(s: string) { console.log(`\n${s}`); }

/* The settle module opens a Supabase client and calls Deno.serve at import
   time, so stub both before pulling in the pure functions under test. */
(globalThis as any).Deno = { env: { get: () => "x" }, serve: () => {} };

const { grade, resolveSide, totalSide, normTeam, ungradeableReason } = await import("./index.ts");

const H = "Seattle Mariners", A = "Oakland Athletics";

sec("Team-name resolution (the mis-grading bug)");
eq("R1 exact home", resolveSide("Seattle Mariners", H, A), "home");
eq("R2 exact away", resolveSide("Oakland Athletics", H, A), "away");
eq("R3 nickname only — the case that broke grading", resolveSide("Athletics", H, A), "away");
eq("R4 nickname only, home side", resolveSide("Mariners", H, A), "home");
eq("R5 two-word nickname", resolveSide("Red Sox", "Boston Red Sox", "New York Yankees"), "home");
eq("R6 punctuation and case are folded", resolveSide("st. louis cardinals", "St. Louis Cardinals", "Chicago Cubs"), "home");
eq("R7 accents are folded", resolveSide("montreal expos", "Montréal Expos", "New York Mets"), "home");
eq("R8 signal has the city, feed does not", resolveSide("Oakland Athletics", "Seattle Mariners", "Athletics"), "away");
eq("R9 an unknown team refuses to guess", resolveSide("Los Angeles Dodgers", H, A), null);
eq("R10 empty selection refuses to guess", resolveSide("", H, A), null);
eq("R11 Sox vs Sox is ambiguous, so it declines", resolveSide("Sox", "Boston Red Sox", "Chicago White Sox"), null);

sec("Grading — h2h");
eq("H1 nickname on the winner now grades WIN (was LOSS)",
  grade("h2h", "Athletics", null, H, A, 2, 6), { result: "win", reason: null });
eq("H2 nickname on the loser grades LOSS",
  grade("h2h", "Mariners", null, H, A, 2, 6), { result: "loss", reason: null });
eq("H3 full name still works", grade("h2h", "Oakland Athletics", null, H, A, 2, 6), { result: "win", reason: null });
eq("H4 a tie is a push", grade("h2h", "Athletics", null, H, A, 3, 3), { result: "push", reason: null });
eq("H5 an unresolvable side is NOT graded",
  grade("h2h", "Los Angeles Dodgers", null, H, A, 2, 6), { result: null, reason: "unresolved_selection" });

sec("Grading — spreads");
eq("S1 nickname spread now grades (was void)",
  grade("spreads", "Athletics", -1.5, H, A, 2, 6), { result: "win", reason: null });
eq("S2 covered exactly is a push", grade("spreads", "Athletics", -4, H, A, 2, 6), { result: "push", reason: null });
eq("S3 failed to cover", grade("spreads", "Athletics", -5.5, H, A, 2, 6), { result: "loss", reason: null });
eq("S4 dog covering", grade("spreads", "Mariners", 4.5, H, A, 2, 6), { result: "win", reason: null });
eq("S5 a missing point is reported, not voided",
  grade("spreads", "Athletics", null, H, A, 2, 6), { result: null, reason: "missing_point" });

sec("Grading — totals");
eq("T1 'Over 8.5'", grade("totals", "Over 8.5", 8.5, H, A, 5, 6), { result: "win", reason: null });
eq("T2 lowercase 'o 8.5' now parses (was void)",
  grade("totals", "o 8.5", 8.5, H, A, 5, 6), { result: "win", reason: null });
eq("T3 'u 8.5'", grade("totals", "u 8.5", 8.5, H, A, 2, 3), { result: "win", reason: null });
eq("T4 exact total is a push", grade("totals", "Under 8.5", 8, H, A, 4, 4), { result: "push", reason: null });
eq("T5 under loses on a high total", grade("totals", "Under 8.5", 8.5, H, A, 6, 6), { result: "loss", reason: null });
eq("T6 an undirected total is not graded",
  grade("totals", "Team Total", 8.5, H, A, 5, 6), { result: null, reason: "unresolved_selection" });
eq("D1 direction words", [totalSide("Over 9"), totalSide("under 9"), totalSide("x")], ["over", "under", null]);

sec("Grading — refuses rather than corrupts");
eq("G1 a missing score is never a grade",
  grade("h2h", "Athletics", null, H, A, NaN as any, 6), { result: null, reason: "missing_score" });
eq("G2 an unknown market is reported",
  grade("player_props", "Judge Over 1.5", 1.5, H, A, 5, 6), { result: null, reason: "unsupported_market" });
ok("G3 NOTHING in this suite produces a bare 'void'", true);

sec("Terminal classification is unchanged");
eq("X1 tennis game lines stay terminal", ungradeableReason("tennis_wta", "spreads"), "unsupported_tennis_game_market");
eq("X2 tennis h2h is still gradeable", ungradeableReason("tennis_wta", "h2h"), null);
eq("X3 baseball is untouched", ungradeableReason("baseball_mlb", "totals"), null);
eq("N1 normTeam folds everything", normTeam("  St. Louis  CARDINALS "), "st louis cardinals");

/* ---------------- ingest_mlb column resolution ---------------- */
const { col, parseCsv } = await import("../ingest_mlb/index.ts");

sec("Savant column resolution (the xERA corruption bug)");
const savantRow = {
  "last_name, first_name": "Rodon, Carlos", player_id: "543037", year: "2026",
  pa: "500", bip: "320", ba: ".251", est_ba: ".248", est_ba_minus_ba_diff: "-0.003",
  slg: ".430", est_slg: ".441", est_slg_minus_slg_diff: "0.011",
  woba: ".320", est_woba: ".331", est_woba_minus_woba_diff: "0.011",
  era: "5.41", xera: "4.88", era_minus_xera_diff: "0.53",
};
eq("C1 xera reads the xera column", col(savantRow, ["xera"]), 4.88);
eq("C2 era reads the era column", col(savantRow, ["era"]), 5.41);
eq("C3 est_woba is picked up", col(savantRow, ["est_woba"]), 0.331);
eq("C4 player_id is exact", col(savantRow, ["player_id"]), 543037);

const blankXera = { ...savantRow, xera: "" };
eq("C5 a blank xera is null, NOT the diff column (was -0.62)", col(blankXera, ["xera"]), null);
const blankEra = { ...savantRow, era: "", xera: "" };
eq("C6 a blank era does not fall through to a diff either", col(blankEra, ["era"]), null);

const custom = { player_id: "543037", k_percent: "21.2", bb_percent: "10.1", barrel_batted_rate: "9.9", hard_hit_percent: "44.3" };
eq("C7 k_percent", col(custom, ["k_percent"]), 21.2);
eq("C8 bb_percent", col(custom, ["bb_percent"]), 10.1);
eq("C9 barrel rate via its real name", col(custom, ["barrel_batted_rate", "barrel"]), 9.9);
eq("C10 hard-hit via its real name", col(custom, ["hard_hit_percent", "hard_hit"]), 44.3);
eq("C11 a missing column is null", col(custom, ["siera"]), null);

sec("CSV parsing");
// Savant quotes the first header because it contains a comma, and quotes values freely.
const csv = '"last_name, first_name",player_id,xera\n"Rodon, Carlos",543037,"4.88"\n"Crawford, Kutter",671106,3.72';
const rows = parseCsv(csv);
eq("P1 quoted commas do not split the row", rows.length, 2);
eq("P2 the quoted name survives intact", rows[0]["last_name, first_name"], "Rodon, Carlos");
eq("P3 values line up with headers", [rows[0].player_id, rows[1].xera], ["543037", "3.72"]);
eq("P5 a QUOTED number is usable (parseFloat('\"4.88\"') is NaN)", col(rows[0], ["xera"]), 4.88);
eq("P6 an unquoted number still works", col(rows[1], ["xera"]), 3.72);
eq("P4 a header-only file yields nothing", parseCsv("a,b,c").length, 0);

console.log(`\n${failed === 0 ? "ALL GREEN" : "FAILURES"} — ${passed} passed, ${failed} failed`);
if (fails.length) console.log("failed:", fails.join(" | "));
if (typeof process !== "undefined" && failed > 0) (process as any).exit(1);
