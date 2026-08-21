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

check("the window counts events, not snapshot rows", () => {
  // The live database reported "0 of 2950 events" one line under "272
  // events", because one check counted distinct events and the other counted
  // rows. Two numbers for the same thing reads as two separate bugs.
  build("pf_rows", "create table public.signals(event_id text, sport_key text, " +
    "commence_time timestamptz, book text); " +
    "insert into public.signals select 'e'||g, 'americanfootball_nfl', " +
    "now()+interval '20 days', b from generate_series(1,4) g, " +
    "unnest(array['dk','fd','mgm']) b");
  const r = run("pf_rows");
  assert.match(r.at("signals").detail, /4 events/, "12 rows are 4 events");
  assert.match(r.at("model window").detail, /0 of 4 /, `got: ${r.at("model window").detail}`);
});

check("nothing reachable says so, and says how far to reach", () => {
  // The real failure: an entire season captured, every game past the
  // look-ahead, and a run that reports success while writing nothing. The
  // only useful output is the number to raise the setting to.
  build("pf_none", "create table public.signals(event_id text, sport_key text, " +
    "commence_time timestamptz); insert into public.signals values " +
    "('e1','americanfootball_nfl', now()+interval '18 days')," +
    "('e2','americanfootball_nfl', now()+interval '140 days')");
  const w = run("pf_none").at("model window");
  assert.equal(w.verdict, "BLOCKED");
  assert.match(w.detail, /NOTHING is reachable/);
  assert.match(w.detail, /at least 43[0-9]/, `18 days is ~432h; got: ${w.detail}`);
  assert.match(w.detail, /or 33[0-9]{2} /, `140 days is ~3360h; got: ${w.detail}`);
});

check("a table missing model_detail is reported as partial, not broken", () => {
  // This is the live shape. A missing optional column costs four CSV
  // columns, not the export, and the difference has to be stated or the
  // creator assumes the file is wrong.
  build("pf_nodetail", "create table public.model_predictions(model_version text, " +
    "event_id text, commence_time timestamptz, home_team text, away_team text, " +
    "market text, selection text, point numeric, model_prob numeric)");
  const r = run("pf_nodetail");
  assert.equal(r.at("columns (required)").verdict, "ok");
  const opt = r.at("columns (optional)");
  assert.equal(opt.verdict, "PARTIAL");
  assert.match(opt.detail, /model_detail/);
  assert.match(opt.detail, /projected spread, total and scores/);
  assert.match(opt.detail, /pick, the market line and the probabilities are unaffected/);
});

check("a table missing a required column is blocked and names it", () => {
  build("pf_nopick", "create table public.model_predictions(model_version text, " +
    "event_id text, commence_time timestamptz, home_team text, away_team text, " +
    "market text, model_prob numeric)");
  const req = run("pf_nopick").at("columns (required)");
  assert.equal(req.verdict, "BLOCKED");
  assert.match(req.detail, /selection/);
  assert.match(req.detail, /point/);
  assert.ok(!/model_prob/.test(req.detail), "named a column that was present");
});

check("a complete table reports both column checks ok", () => {
  build("pf_fullcols", "create table public.model_predictions(model_version text, " +
    "event_id text, commence_time timestamptz, home_team text, away_team text, " +
    "market text, selection text, point numeric, model_prob numeric, " +
    "model_detail jsonb, model_edge numeric, model_ev numeric, " +
    "market_prob_at_pred numeric, best_am_at_pred int)");
  const r = run("pf_fullcols");
  assert.equal(r.at("columns (required)").verdict, "ok");
  assert.equal(r.at("columns (optional)").verdict, "ok");
});

check("an existing predictions table with no NFL rows reads 'empty'", () => {
  // Distinct from BLOCKED: nothing is broken, the model simply has not run.
  build("pf_pred", "create table public.model_predictions(model_version text, x int)");
  const p = run("pf_pred").at("model_predictions");
  assert.equal(p.verdict, "empty");
  assert.match(p.detail, /model_to_csv/);
});

check("an empty table for every model points at the likely cause", () => {
  // model_predict sending a column the table does not have makes PostgREST
  // reject the entire insert. An empty table and a missing optional column
  // together are that failure, and it is invisible from either one alone.
  build("pf_allempty", "create table public.model_predictions(model_version text, " +
    "event_id text, commence_time timestamptz, home_team text, away_team text, " +
    "market text, selection text, point numeric, model_prob numeric)");
  const a = run("pf_allempty").at("all models");
  assert.equal(a.verdict, "empty");
  assert.match(a.detail, /PostgREST rejects the whole insert/);
});

check("a table with other sports in it lists them", () => {
  build("pf_mixed", "create table public.model_predictions(model_version text, " +
    "event_id text, commence_time timestamptz, home_team text, away_team text, " +
    "market text, selection text, point numeric, model_prob numeric); " +
    "insert into public.model_predictions(model_version) select 'mlb_runs_v1.2' " +
    "from generate_series(1,7); " +
    "insert into public.model_predictions(model_version) values ('ufc_fight_v1')");
  const a = run("pf_mixed").at("all models");
  assert.equal(a.verdict, "ok");
  assert.match(a.detail, /mlb_runs_v1\.2 \(7\)/);
  assert.match(a.detail, /ufc_fight_v1 \(1\)/);
});

console.log(`\n${passed} checks passed`);
if (process.exitCode) console.error("SOME PREFLIGHT TESTS FAILED");
else console.log("ALL PREFLIGHT TESTS PASSED");
