// Tests for the in-site slate uploader's pick parsing.
//
//   node tests/collective/slate_upload.test.mjs
//
// The functions live inline in collective/index.html, so they are extracted
// and evaluated here rather than imported. That is deliberate: the deployed
// artifact is the HTML, so the test reads the same text the browser will.
//
// The sign flip is why this file exists. A line stored for the wrong side
// inverts every game on the board and still looks entirely reasonable — -3.5
// and +3.5 are both real numbers and both render fine. It only surfaces later
// as a record that grades backwards.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "..", "collective", "index.html"), "utf8");

function extract(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is not in collective/index.html`);
  // Walk braces from the first { after the signature.
  let i = html.indexOf("{", start), depth = 0, end = -1;
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.notEqual(end, -1, `could not find the end of ${name}`);
  return html.slice(start, end);
}

const { slatePick, slateSide, weekOptions, slateDetectWeek, WEEK_NAMES } =
  (new Function(
    `var WEEK_NAMES=${JSON.stringify({19:"Wild Card",20:"Divisional",21:"Conference Championship",22:"Super Bowl"})};` +
    `${extract("slateSide")}\n${extract("slatePick")}\n` +
    `${extract("weekOptions")}\n${extract("slateDetectWeek")}\n` +
    `return {slatePick, slateSide, weekOptions, slateDetectWeek, WEEK_NAMES};`
  ))();

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

// ------------------------------------------------------------ the sign flip

check("an away pick becomes the home number, negated", () => {
  // "NE +3.5" with NE away means the home team is laying 3.5.
  assert.deepEqual(slatePick("NE +3.5", "SEA", "NE"), { side: "away", line: -3.5 });
});

check("a home pick is already the home number", () => {
  assert.deepEqual(slatePick("LA -3.5", "LA", "SF"), { side: "home", line: -3.5 });
});

check("an away favourite becomes a home dog", () => {
  assert.deepEqual(slatePick("CHI -2.5", "CAR", "CHI"), { side: "away", line: 2.5 });
});

check("a home dog stays positive", () => {
  assert.deepEqual(slatePick("IND +3.5", "IND", "BAL"), { side: "home", line: 3.5 });
});

check("pick'em is zero, not missing", () => {
  // Dropped, the pick renders with no line at all.
  for (const w of ["PK", "pk", "PICK", "even"]) {
    const got = slatePick(`BUF ${w}`, "HOU", "BUF");
    assert.equal(got.side, "away", w);
    assert.equal(got.line, 0, w);
  }
});

check("whole numbers parse", () => {
  assert.deepEqual(slatePick("ATL +3", "PIT", "ATL"), { side: "away", line: -3 });
  assert.deepEqual(slatePick("NO +7", "DET", "NO"), { side: "away", line: -7 });
});

// ------------------------------------------ the whole real slate, at once

check("Moose's actual Week 1 slate maps to the captured market", () => {
  // Right side of each pair is the consensus this project's own feed stored,
  // in home convention. Independent confirmation of the sign, not a restated
  // assumption: these numbers came from sportsbooks, not from this code.
  const slate = [
    ["NE +3.5",    "SEA", "NE",  -3.5],
    ["LA -3.5",    "LA",  "SF",  -3.5],
    ["ARI +10.5",  "LAC", "ARI", -10.5],
    ["ATL +3",     "PIT", "ATL", -3],
    ["IND +3.5",   "IND", "BAL",  3.5],
    ["CHI -2.5",   "CAR", "CHI",  2.5],
    ["CLE +7.5",   "JAX", "CLE", -7.5],
    ["NO +7",      "DET", "NO",  -7],
    ["NYJ +2.5",   "TEN", "NYJ", -2.5],
    ["TB +3.5",    "CIN", "TB",  -3.5],
    ["MIA +3.5",   "LV",  "MIA", -3.5],
  ];
  for (const [pick, home, away, expected] of slate) {
    const got = slatePick(pick, home, away);
    assert.ok(got, `${pick} did not parse`);
    assert.equal(got.line, expected,
      `${pick} (${away} @ ${home}) mapped to ${got.line}, market says ${expected}`);
  }
});

// --------------------------------------------------------- side resolution

check("the old exact forms still work", () => {
  // home / away / h / a / road / bare team code were all accepted before and
  // must keep working, or a CSV that used to upload suddenly stops.
  assert.equal(slateSide("home", "SEA", "NE"), "home");
  assert.equal(slateSide("away", "SEA", "NE"), "away");
  assert.equal(slateSide("h", "SEA", "NE"), "home");
  assert.equal(slateSide("a", "SEA", "NE"), "away");
  assert.equal(slateSide("road", "SEA", "NE"), "away");
  assert.equal(slateSide("SEA", "SEA", "NE"), "home");
  assert.equal(slateSide("NE", "SEA", "NE"), "away");
});

check("a bare team code with no number keeps the side", () => {
  assert.deepEqual(slatePick("NE", "SEA", "NE"), { side: "away", line: null });
});

check("a full name resolves against a code", () => {
  assert.equal(slateSide("Cincinnati Bengals", "CIN", "TB"), "home");
  assert.deepEqual(slatePick("Cincinnati Bengals -3.5", "CIN", "TB"),
    { side: "home", line: -3.5 });
});

check("a two letter code matches exactly or not at all", () => {
  // NE at NO. A prefix match here books the away pick as the home one and
  // inverts the game while looking perfectly normal.
  assert.equal(slateSide("NE", "NO", "NE"), "away");
  assert.equal(slateSide("NO", "NO", "NE"), "home");
});

check("an ambiguous name is refused rather than guessed", () => {
  assert.equal(slateSide("New", "New England", "New Orleans"), null);
});

check("an unknown team returns nothing, so the row is reported", () => {
  assert.equal(slatePick("Nowhere United -3", "SEA", "NE"), null);
});

check("an empty cell is not a pick and not an error", () => {
  assert.equal(slatePick("", "SEA", "NE"), null);
  assert.equal(slatePick("   ", "SEA", "NE"), null);
  assert.equal(slatePick(null, "SEA", "NE"), null);
  assert.equal(slatePick(undefined, "SEA", "NE"), null);
});

check("case and punctuation do not matter", () => {
  assert.deepEqual(slatePick("ne +3.5", "SEA", "NE"), { side: "away", line: -3.5 });
  assert.deepEqual(slatePick("  NE   +3.5  ", "SEA", "NE"), { side: "away", line: -3.5 });
});

// ------------------------------------------------------------------ week

check("every week is offered, with the playoff rounds named", () => {
  // "Week 20" is not how anyone refers to the Divisional round, and posting
  // the wrong week grades a slate against the wrong games.
  const html = weekOptions();
  for (let w = 1; w <= 18; w++) {
    assert.ok(html.includes(`>Week ${w}<`), `Week ${w} missing`);
  }
  for (const name of ["Wild Card", "Divisional", "Conference Championship", "Super Bowl"]) {
    assert.ok(html.includes(`>${name}<`), `${name} missing`);
  }
  assert.ok(html.includes('value=""'), "an auto option must exist");
});

check("the detected week is preselected", () => {
  assert.match(weekOptions(3), /value="3" selected/);
  assert.equal(/selected/.test(weekOptions()), false);
});

check("the week is the most common value, not the first row", () => {
  // One typo'd row should not decide the whole slate.
  const rows = [["week"], ["1"], ["1"], ["11"], ["1"], ["1"]];
  assert.equal(slateDetectWeek(rows, 0), 1);
});

check("a week column with junk in it does not produce a week", () => {
  assert.equal(slateDetectWeek([["week"], [""], ["n/a"], ["-"]], 0), null);
  assert.equal(slateDetectWeek([["week"], ["99"], ["0"]], 0), null);
});

check("no week column means no guess", () => {
  assert.equal(slateDetectWeek([["home"], ["SEA"]], undefined), null);
  assert.equal(slateDetectWeek([["home"], ["SEA"]], null), null);
});

check("a week written as 'Week 5' still reads as 5", () => {
  assert.equal(slateDetectWeek([["week"], ["Week 5"], ["Week 5"]], 0), 5);
});

console.log(`\n${passed} checks passed`);
if (process.exitCode) console.error("SOME SLATE UPLOAD TESTS FAILED");
else console.log("ALL SLATE UPLOAD TESTS PASSED");
