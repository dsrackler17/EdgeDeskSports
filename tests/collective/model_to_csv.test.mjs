// model_predictions -> exporter SQL -> CSV -> the browser's own parser.
//
//   node tests/collective/model_to_csv.test.mjs
//
// The exporter is one SQL file and the uploader is one HTML file, written
// months apart, and nothing in either one references the other. The place
// they have to agree is the CSV in between: a pick string the exporter is
// happy to write and the uploader refuses to read produces an empty board
// and no error anywhere. So this test runs the real file against a real
// Postgres and feeds the real bytes to the real parser.
//
// It also pins the sign. An away favourite is written "-2.5" on the pick and
// "+2.5" as the home line, and the model's margin is negative for the same
// game. Three numbers, three conventions, and every one of them looks
// perfectly reasonable when it is wrong.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const DB = process.env.PGDATABASE || "nflcsv";

function psql(args) {
  return execFileSync("su", ["postgres", "-c",
    `psql -v ON_ERROR_STOP=1 -d ${DB} ${args}`], { encoding: "utf8" });
}

// ------------------------------------------------------- build the database

execFileSync("su", ["postgres", "-c",
  `psql -q -c 'drop database if exists ${DB};' -c 'create database ${DB};'`],
  { encoding: "utf8" });
psql(`-q -f ${join(root, "tests/collective/model_predictions_fixture.sql")}`);

const EXPORTER = join(root, "tools/collective/model_to_csv.sql");
const csv = psql(`-q --csv -f ${EXPORTER}`).trim() + "\n";

// ------------------------------------------- the uploader, out of the HTML

const html = readFileSync(join(root, "collective", "index.html"), "utf8");

function block(startsWith, opener = "{", closer = "}") {
  const start = html.indexOf(startsWith);
  assert.notEqual(start, -1, `${startsWith} is not in collective/index.html`);
  let i = html.indexOf(opener, start), depth = 0, end = -1;
  for (; i < html.length; i++) {
    if (html[i] === opener) depth++;
    else if (html[i] === closer) { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.notEqual(end, -1, `could not find the end of ${startsWith}`);
  return html.slice(start, end);
}

const NAMES = [
  "parseCSV", "slateGuessMap", "slateBuildRows", "slateKick", "slateNum",
  "slatePick", "slateSide", "slateDetectWeek",
];
const P = (new Function([
  block("var SLATE_FIELDS=", "[", "]") + ";",
  "var SLATE={cols:[],rows:[],map:{}};",
  "function esc(s){return String(s==null?'':s);}",
  ...NAMES.map((n) => block(`function ${n}(`)),
  `return {${NAMES.join(",")}, SLATE:SLATE, setSlate:function(s){` +
  `SLATE.cols=s.cols;SLATE.rows=s.rows;SLATE.map=s.map;}};`,
].join("\n")))();

const parsed = P.parseCSV(csv);
P.setSlate({ cols: parsed[0], rows: parsed, map: {} });
P.slateGuessMap();
const built = P.slateBuildRows();
const rows = built.rows || built;
const problems = built.problems || [];
const byHome = Object.fromEntries(rows.map((r) => [r.home_team, r]));

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log(`pass: ${label}`); }
  catch (e) { console.error(`FAIL: ${label}\n      ${e.message}`); process.exitCode = 1; }
}

// -------------------------------------------------------------- the export

check("one row per game, not one per market", () => {
  // Four rows went in for game A. A missing GROUP BY exports the game four
  // times and the creator submits the same pick four times.
  const lines = csv.trim().split("\n");
  assert.equal(lines.length - 1, 5, `expected 5 games, got:\n${csv}`);
});

check("the week filter excludes Week 2", () => {
  assert.ok(!csv.includes("Green Bay"), "a Week 2 game reached a Week 1 export");
});

check("the model_version filter excludes other sports", () => {
  assert.ok(!csv.includes("Red Sox"), "an MLB row reached an NFL export");
});

check("every header the uploader needs is recognised", () => {
  // An unmapped required column stops the upload dead, and an unmapped
  // optional one silently drops the number.
  for (const f of ["home_team", "away_team", "kickoff", "pick_side",
                   "line_at_submission", "projected_spread", "projected_total",
                   "home_win_probability", "cover_probability",
                   "proj_home_score", "proj_away_score", "week"]) {
    assert.ok(P.SLATE.map[f] !== undefined && P.SLATE.map[f] !== null,
      `${f} did not auto-map from the exporter's headers`);
  }
});

check("no header is ambiguous enough to raise the spread question", () => {
  // "spread" and "line" are the two headers that could mean either the
  // model's number or the book's. The exporter names both explicitly so the
  // creator is never asked.
  const header = csv.split("\n")[0].toLowerCase().split(",");
  for (const bad of ["spread", "line"]) {
    assert.ok(!header.includes(bad), `header "${bad}" is ambiguous`);
  }
});

check("no row is rejected by the uploader", () => {
  assert.deepEqual(problems, [], problems.join("\n"));
  assert.equal(rows.length, 5);
});

// --------------------------------------------------------------- the signs

check("home favourite: pick, home line and margin all agree", () => {
  const r = byHome["Seattle Seahawks"];
  assert.equal(r.pick_side, "home");
  assert.equal(r.line_at_submission, -3.5, "home laying 3.5");
  assert.equal(r.projected_spread, -4.8, "sim_mean_margin +4.8 => home -4.8");
});

check("away favourite: the pick is -2.5 but the home line is +2.5", () => {
  // The one that inverts a whole board when it is wrong.
  const r = byHome["Carolina Panthers"];
  assert.equal(r.pick_side, "away");
  assert.equal(r.line_at_submission, 2.5, "away laying 2.5 => home +2.5");
  assert.equal(r.projected_spread, 3.2, "sim_mean_margin -3.2 => home +3.2");
});

check("the exporter picks the side with the larger edge", () => {
  // Both sides of every spread are in the table. Exporting the home side by
  // default would file the model's opinion backwards on every away pick.
  assert.ok(csv.includes("Chicago Bears -2.5"), `expected the away side:\n${csv}`);
  assert.ok(!csv.includes("Carolina Panthers +2.5"), "exported the losing side too");
});

check("pick'em is written PK and reads back as zero", () => {
  const r = byHome["Houston Texans"];
  assert.equal(r.pick_side, "away");
  assert.equal(r.line_at_submission, 0);
});

check("a whole-number point survives the round trip, both signs", () => {
  // to_char(7,'FM999990.9') is "7.", and the uploader refuses "NO +7."
  // outright: a trailing dot with no digit after it is not a number. Half
  // points never reach this branch, so both signs are pinned here.
  assert.ok(csv.includes("New Orleans Saints +7,"), `expected "+7":\n${csv}`);
  assert.ok(csv.includes("Kansas City Chiefs -6,"), `expected "-6":\n${csv}`);

  const away = byHome["Detroit Lions"];
  assert.equal(away.pick_side, "away");
  assert.equal(away.line_at_submission, -7, "away +7 => home -7");

  const home = byHome["Kansas City Chiefs"];
  assert.equal(home.pick_side, "home");
  assert.equal(home.line_at_submission, -6);
});

// -------------------------------------------------------- the model's rest

check("a game with no moneyline row still exports", () => {
  // Game C has a spread and nothing else. An inner join on h2h drops it.
  assert.ok(byHome["Houston Texans"], "the pick'em game was dropped");
  assert.equal(byHome["Houston Texans"].home_win_probability, undefined,
    "an absent moneyline must be absent, not zero");
});

check("home_win_probability is the HOME side's number", () => {
  // Carolina is the underdog and both moneyline rows exist for that game, so
  // an exporter that takes whichever h2h row sorts highest returns Chicago's
  // 0.59 and files it under Carolina's name. It looks entirely reasonable.
  assert.equal(byHome["Seattle Seahawks"].home_win_probability, 0.63);
  assert.equal(byHome["Carolina Panthers"].home_win_probability, 0.41);
});

check("cover probability follows the exported side", () => {
  assert.equal(byHome["Seattle Seahawks"].cover_probability, 0.56);
  assert.equal(byHome["Carolina Panthers"].cover_probability, 0.58);
});

check("scores and totals ride along", () => {
  const r = byHome["Seattle Seahawks"];
  assert.equal(r.projected_total, 44.1);
  assert.equal(r.proj_home_score, 24.45);
  assert.equal(r.proj_away_score, 19.65);
});

check("the price-discrepancy columns are present and are percentages", () => {
  const header = csv.split("\n")[0].split(",");
  for (const c of ["model_edge_pct", "model_ev_pct", "market_prob_pct", "best_price"]) {
    assert.ok(header.includes(c), `${c} missing from the export`);
  }
  const i = header.indexOf("model_edge_pct");
  const bears = csv.split("\n").find((l) => l.includes("Chicago Bears"));
  assert.equal(bears.split(",")[i], "6.10", "0.0610 should read as 6.10%");
});

check("the context columns do not disturb the upload", () => {
  // The uploader must ignore what it does not recognise rather than guess.
  for (const r of rows) {
    for (const k of ["model_edge_pct", "model_ev_pct", "market_prob_pct", "best_price"]) {
      assert.ok(!(k in r), `${k} would be POSTed`);
    }
  }
});

check("only finished numbers leave the project", () => {
  // No weights, no feature values, no source table names, no model version.
  for (const leak of ["epa", "source_table", "nfl_game_v1", "feature", "basis"]) {
    assert.ok(!csv.toLowerCase().includes(leak), `"${leak}" reached the CSV`);
  }
});

// ------------------------------------------------------------ empty is fine

check("an empty table exports nothing rather than something", () => {
  psql(`-q -c 'truncate public.model_predictions;'`);
  const empty = psql(`-q --csv -f ${EXPORTER}`).trim();
  const lines = empty ? empty.split("\n") : [];
  assert.ok(lines.length <= 1, `expected headers only, got:\n${empty}`);
});

console.log(`\n${passed} checks passed`);
if (process.exitCode) console.error("SOME EXPORTER TESTS FAILED");
else console.log("ALL EXPORTER TESTS PASSED");
