// The preflight, against four database shapes.
//
//   node tests/collective/nfl_preflight.test.mjs
//
// A diagnostic that errors out on a database missing the very tables it is
// checking for is worse than no diagnostic: it reports a broken query where
// the honest answer was "that table does not exist, and that is your
// blocker". So the shapes below are deliberately hostile — nothing exists,
// then some of it, then a column short, then satisfied — and the file has to
// come back with an answer every time.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SQL = join(root, "tools/collective/nfl_preflight.sql");

function su(cmd) {
  return execFileSync("su", ["postgres", "-c", cmd], { encoding: "utf8" });
}
function build(db, setup) {
  su(`psql -q -c 'drop database if exists ${db};' -c 'create database ${db};'`);
  if (setup) su(`psql -q -v ON_ERROR_STOP=1 -d ${db} -c ${JSON.stringify(setup)}`);
}
// Rows come back as step|verdict|detail so a verdict can be asserted without
// parsing the prose around it.
function run(db) {
  const out = su(`psql -q -tAF'|' -v ON_ERROR_STOP=1 -d ${db} -f ${SQL}`);
  const rows = out.trim().split("\n").filter(Boolean).map((l) => {
    const [step, verdict, ...rest] = l.split("|");
    return { step, verdict, detail: rest.join("|") };
  });
  return { rows, at: (frag) => rows.find((r) => r.step.includes(frag)) };
}

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log(`pass: ${label}`); }
  catch (e) { console.error(`FAIL: ${label}\n      ${e.message}`); process.exitCode = 1; }
}

const FEATURES = "create table public.nfl_team_features(team text primary key, " +
  "off_epa_play numeric, def_epa_play numeric)";
const SIGNALS = "create table public.signals(event_id text, sport_key text, " +
  "commence_time timestamptz); insert into public.signals values " +
  "('e1','americanfootball_nfl', now()+interval '20 days')," +
  "('e2','americanfootball_nfl', now()+interval '25 days')," +
  "('e3','americanfootball_nfl_preseason', now()+interval '2 days')";

check("an empty database answers instead of erroring", () => {
  build("pf_empty", null);
  const r = run("pf_empty");
  assert.ok(r.rows.length >= 3, `expected findings, got ${r.rows.length}`);
  assert.equal(r.at("nfl_team_features").verdict, "BLOCKED");
  assert.match(r.at("nfl_team_features").detail, /off_epa_play/);
  assert.equal(r.at("signals").verdict, "BLOCKED");
});

check("a features table short one column names that column", () => {
  // "something is wrong with nfl_team_features" is not actionable.
  build("pf_partial", FEATURES);
  const f = run("pf_partial").at("nfl_team_features");
  assert.equal(f.verdict, "BLOCKED");
  assert.match(f.detail, /missing: plays_per_game/);
  assert.ok(!/off_epa_play/.test(f.detail), "named a column that was present");
});

check("a complete but empty features table is still blocked", () => {
  build("pf_cols", FEATURES + "; alter table public.nfl_team_features add column plays_per_game numeric");
  const f = run("pf_cols").at("nfl_team_features");
  assert.equal(f.verdict, "BLOCKED");
  assert.match(f.detail, /empty/);
});

check("a populated features table passes", () => {
  build("pf_ok", FEATURES + "; alter table public.nfl_team_features add column plays_per_game numeric" +
    "; insert into public.nfl_team_features values ('KC',0.12,-0.05,63)");
  const f = run("pf_ok").at("nfl_team_features");
  assert.equal(f.verdict, "ok");
  assert.match(f.detail, /1 row,/, "singular, not '1 rows'");
});

check("games beyond the look-ahead are reported, not counted as fine", () => {
  // The window default is 192h and Week 1 is further out than that. A run
  // that skips them still reports success, so this is the only place the
  // creator would ever find out.
  build("pf_window", SIGNALS);
  const w = run("pf_window").at("model window");
  assert.equal(w.verdict, "PARTIAL");
  assert.match(w.detail, /1 of 3/);
  assert.match(w.detail, /skipped in silence/);
});

check("a preseason sport_key counts as NFL", () => {
  // The registry routes by prefix, so americanfootball_nfl_preseason is the
  // same model. Matching on equality would under-report the capture.
  build("pf_pre", "create table public.signals(event_id text, sport_key text, " +
    "commence_time timestamptz); insert into public.signals values " +
    "('e1','americanfootball_nfl_preseason', now()+interval '2 days')");
  const s = run("pf_pre").at("signals");
  assert.equal(s.verdict, "ok");
  assert.match(s.detail, /1 events/);
});

check("no captured NFL events is a blocker with its own wording", () => {
  build("pf_nosig", "create table public.signals(event_id text, sport_key text, commence_time timestamptz)");
  const s = run("pf_nosig").at("signals");
  assert.equal(s.verdict, "BLOCKED");
  assert.match(s.detail, /odds schema/, "should point at where the Collective feed writes");
});

check("an existing predictions table with no NFL rows reads 'empty'", () => {
  // Distinct from BLOCKED: nothing is broken, the model simply has not run.
  build("pf_pred", "create table public.model_predictions(model_version text, x int)");
  const p = run("pf_pred").at("model_predictions");
  assert.equal(p.verdict, "empty");
  assert.match(p.detail, /model_to_csv/);
});

console.log(`\n${passed} checks passed`);
if (process.exitCode) console.error("SOME PREFLIGHT TESTS FAILED");
else console.log("ALL PREFLIGHT TESTS PASSED");
