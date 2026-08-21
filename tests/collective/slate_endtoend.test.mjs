// The whole in-page upload path, on the real file.
//
//   node tests/collective/slate_endtoend.test.mjs
//
// The unit tests cover slatePick in isolation, which is not the thing that
// kept failing. What failed was the path: parse the file, guess the columns,
// build the rows. A perfect pick parser is worthless if the column guesser
// never points at the pick column, and that is invisible from a unit test.
//
// So this runs the creator's actual CSV — headers and all — through the same
// functions the browser runs, out of the same HTML the browser downloads, and
// asserts the envelope that would be POSTed.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "..", "collective", "index.html"), "utf8");

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
const src = [
  block("var SLATE_FIELDS=", "[", "]") + ";",
  "var SLATE={cols:[],rows:[],map:{}};",
  // slateBuildRows reports row problems through esc(); the browser has it.
  "function esc(s){return String(s==null?'':s);}",
  ...NAMES.map((n) => block(`function ${n}(`)),
  `return {${NAMES.join(",")}, SLATE:SLATE, setSlate:function(s){SLATE.cols=s.cols;SLATE.rows=s.rows;SLATE.map=s.map;}};`,
].join("\n");

const P = (new Function(src))();

// Byte for byte the creator's file, including the header row.
const CSV = `date,game_id,season,week,away,home,pick
2026-09-09,2026_01_NE_SEA,2026,1,NE,SEA,NE +3.5
2026-09-10,2026_01_SF_LA,2026,1,SF,LA,LA -3.5
2026-09-13,2026_01_ARI_LAC,2026,1,ARI,LAC,ARI +10.5
2026-09-13,2026_01_ATL_PIT,2026,1,ATL,PIT,ATL +3
2026-09-13,2026_01_BAL_IND,2026,1,BAL,IND,IND +3.5
2026-09-13,2026_01_BUF_HOU,2026,1,BUF,HOU,BUF PK
2026-09-13,2026_01_CHI_CAR,2026,1,CHI,CAR,CHI -2.5
2026-09-13,2026_01_CLE_JAX,2026,1,CLE,JAX,CLE +7.5
2026-09-13,2026_01_DAL_NYG,2026,1,DAL,NYG,DAL -2.5
2026-09-13,2026_01_GB_MIN,2026,1,GB,MIN,GB +1.5
2026-09-13,2026_01_MIA_LV,2026,1,MIA,LV,MIA +3.5
2026-09-13,2026_01_NO_DET,2026,1,NO,DET,NO +7
2026-09-13,2026_01_NYJ_TEN,2026,1,NYJ,TEN,NYJ +2.5
2026-09-13,2026_01_TB_CIN,2026,1,TB,CIN,TB +3.5
2026-09-13,2026_01_WAS_PHI,2026,1,WAS,PHI,PHI -4.5
2026-09-14,2026_01_DEN_KC,2026,1,DEN,KC,DEN +2.5
`;

function load(text) {
  const rows = P.parseCSV(text);
  P.setSlate({ cols: rows[0], rows: rows, map: {} });
  P.slateGuessMap();
  return rows;
}

let passed = 0;
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`pass: ${label}`);
  } catch (e) {
    console.error(`FAIL: ${label}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

check("the file parses to 16 games plus a header", () => {
  const rows = load(CSV);
  assert.equal(rows.length, 17);
  assert.deepEqual(rows[0], ["date", "game_id", "season", "week", "away", "home", "pick"]);
});

check("the column guesser finds the pick column, which is the whole game", () => {
  load(CSV);
  // A pick parser that never sees the pick column is worth nothing.
  assert.notEqual(P.SLATE.map["pick_side"], undefined, "pick column not mapped");
  assert.equal(P.SLATE.cols[P.SLATE.map["pick_side"]], "pick");
  assert.equal(P.SLATE.cols[P.SLATE.map["home_team"]], "home");
  assert.equal(P.SLATE.cols[P.SLATE.map["away_team"]], "away");
  assert.equal(P.SLATE.cols[P.SLATE.map["kickoff"]], "date");
  assert.equal(P.SLATE.cols[P.SLATE.map["week"]], "week");
});

check("week 1 is detected from the file", () => {
  const rows = load(CSV);
  assert.equal(P.slateDetectWeek(rows, P.SLATE.map["week"]), 1);
});

check("EVERY row is built with both a side and a line", () => {
  // This is the assertion that would have caught the live failure.
  load(CSV);
  const { rows, problems } = P.slateBuildRows(2026, 1);
  assert.deepEqual(problems, [], `unexpected row problems: ${problems.join(" | ")}`);
  assert.equal(rows.length, 16);
  const noSide = rows.filter((r) => r.pick_side === undefined);
  const noLine = rows.filter((r) => r.line_at_submission === undefined);
  assert.equal(noSide.length, 0, `${noSide.length} rows had no pick_side`);
  assert.equal(noLine.length, 0, `${noLine.length} rows had no line_at_submission`);
});

check("the lines are in home convention and match the captured market", () => {
  load(CSV);
  const { rows } = P.slateBuildRows(2026, 1);
  const by = {};
  rows.forEach((r) => { by[`${r.away_team}@${r.home_team}`] = r; });
  // Right-hand numbers are the consensus this project's own odds feed stored.
  const expect = {
    "NE@SEA": -3.5, "SF@LA": -3.5, "ARI@LAC": -10.5, "ATL@PIT": -3,
    "BAL@IND": 3.5, "CHI@CAR": 2.5, "CLE@JAX": -7.5, "NO@DET": -7,
    "NYJ@TEN": -2.5, "TB@CIN": -3.5, "MIA@LV": -3.5, "BUF@HOU": 0,
  };
  for (const [game, line] of Object.entries(expect)) {
    assert.ok(by[game], `${game} missing from the built rows`);
    assert.equal(by[game].line_at_submission, line,
      `${game} built ${by[game].line_at_submission}, market says ${line}`);
  }
});

check("the side matches the team named in the pick cell", () => {
  load(CSV);
  const { rows } = P.slateBuildRows(2026, 1);
  const by = {};
  rows.forEach((r) => { by[`${r.away_team}@${r.home_team}`] = r; });
  assert.equal(by["NE@SEA"].pick_side, "away");    // "NE +3.5"
  assert.equal(by["SF@LA"].pick_side, "home");     // "LA -3.5"
  assert.equal(by["BAL@IND"].pick_side, "home");   // "IND +3.5"
  assert.equal(by["WAS@PHI"].pick_side, "home");   // "PHI -4.5"
});

check("the week rides along on every row", () => {
  load(CSV);
  const { rows } = P.slateBuildRows(2026, 1);
  assert.ok(rows.every((r) => r.week === 1), "every row should carry week 1");
});

check("kickoff becomes a real timestamp, not a bare date", () => {
  load(CSV);
  const { rows } = P.slateBuildRows(2026, 1);
  for (const r of rows) {
    assert.ok(!Number.isNaN(Date.parse(r.kickoff)), `${r.kickoff} is not a time`);
  }
});

check("only finished numbers are sent, never anything else", () => {
  const allowed = new Set([
    "game_ref", "home_team", "away_team", "kickoff", "week", "pick_side",
    "line_at_submission", "projected_spread", "projected_total",
    "home_win_probability", "cover_probability", "proj_home_score",
    "proj_away_score", "confidence",
  ]);
  load(CSV);
  const { rows } = P.slateBuildRows(2026, 1);
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      assert.ok(allowed.has(k), `unexpected field would be sent: ${k}`);
    }
  }
});

check("a market line column, when present, beats the number in the pick", () => {
  load(CSV.replace("away,home,pick", "away,home,pick,market_line")
          .replace(/(2026_01_NE_SEA,2026,1,NE,SEA,NE \+3\.5)/, "$1,-4.5")
          .replace(/,(1,[A-Z]+,[A-Z]+,[A-Z]+ [+-]?[\d.]+)$/gm, ",$1,"));
  const { rows } = P.slateBuildRows(2026, 1);
  const ne = rows.find((r) => r.away_team === "NE");
  assert.equal(ne.line_at_submission, -4.5, "an explicit column must win");
});

check("Excel's quoted CSV export parses the same", () => {
  // Excel quotes fields it feels like quoting; the result must not change.
  const quoted = CSV.split("\n").map((line, i) =>
    i === 0 || !line ? line : line.split(",").map((c) => `"${c}"`).join(",")
  ).join("\n");
  load(quoted);
  const { rows, problems } = P.slateBuildRows(2026, 1);
  assert.deepEqual(problems, []);
  assert.equal(rows.length, 16);
  assert.equal(rows.filter((r) => r.line_at_submission === undefined).length, 0);
});

check("a CRLF file from Windows parses the same", () => {
  load(CSV.replace(/\n/g, "\r\n"));
  const { rows, problems } = P.slateBuildRows(2026, 1);
  assert.deepEqual(problems, []);
  assert.equal(rows.length, 16);
  assert.equal(rows.filter((r) => r.line_at_submission === undefined).length, 0);
});

// ------------------------------------------- the one ambiguous column

// "spread" and "line" each mean two different things depending on the
// creator: the number their model produced, or the number the book showed.
// Guessed one way and never asked, the wrong one is silently wrong forever —
// a market line stored as a projection measures accuracy against the market
// instead of against the result.

const AMBIG = block("var AMBIGUOUS_SPREAD=", "[", "]");

check("the ambiguous headers are named, not left to a guess", () => {
  assert.match(AMBIG, /'spread'/);
  assert.match(AMBIG, /'line'/);
});

check("a column called 'spread' maps to the creator's own number by default", () => {
  // The commoner intent, and the one the question then confirms.
  load(CSV.replace("away,home,pick", "away,home,pick,spread")
          .split("\n").map((l, i) => (i === 0 || !l ? l : l + ",-3.0")).join("\n"));
  assert.notEqual(P.SLATE.map["projected_spread"], undefined);
  assert.equal(P.SLATE.map["line_at_submission"], undefined);
  assert.equal(P.SLATE.cols[P.SLATE.map["projected_spread"]], "spread");
});

check("an unambiguous pair is never questioned", () => {
  // A file carrying both leaves nothing to ask about.
  load(CSV.replace("away,home,pick", "away,home,pick,spread,market_line")
          .split("\n").map((l, i) => (i === 0 || !l ? l : l + ",-3.0,-3.5")).join("\n"));
  assert.notEqual(P.SLATE.map["projected_spread"], undefined);
  assert.notEqual(P.SLATE.map["line_at_submission"], undefined);
});

check("an explicit market line column reaches the built rows", () => {
  load(CSV.replace("away,home,pick", "away,home,pick,market_line")
          .split("\n").map((l, i) => (i === 0 || !l ? l : l + ",-9.5")).join("\n"));
  const { rows } = P.slateBuildRows(2026, 1);
  assert.equal(rows.length, 16);
  // The explicit column wins over the number inside the pick cell.
  assert.ok(rows.every((r) => r.line_at_submission === -9.5),
    "an explicit market_line column must win over the pick's own number");
});

check("a projected spread column reaches the built rows separately", () => {
  load(CSV.replace("away,home,pick", "away,home,pick,model_spread")
          .split("\n").map((l, i) => (i === 0 || !l ? l : l + ",-2.0")).join("\n"));
  const { rows } = P.slateBuildRows(2026, 1);
  assert.ok(rows.every((r) => r.projected_spread === -2), "model_spread must map to projected_spread");
  // and the pick's own number still supplies the market line
  assert.ok(rows.every((r) => r.line_at_submission !== undefined),
    "the pick cell should still supply the market line");
});

console.log(`\n${passed} checks passed`);
if (process.exitCode) console.error("SOME END TO END SLATE TESTS FAILED");
else console.log("ALL END TO END SLATE TESTS PASSED");
