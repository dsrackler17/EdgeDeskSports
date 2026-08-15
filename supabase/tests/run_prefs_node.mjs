#!/usr/bin/env node
// ============================================================================
//  FILE:  supabase/tests/run_prefs_node.mjs
//  RUN:   node supabase/tests/run_prefs_node.mjs
//
//  Exercises the Settings features that used to be NOT AVAILABLE gates:
//  favourite teams, and the shared odds-price formatter.
//
//  Both were gated for honest reasons, and both are only worth un-gating if
//  they actually do something. These tests assert the "actually does
//  something" part — that a favourite filters and marks the board, and that a
//  format change moves every display price while leaving the numbers the
//  LEDGER stores untouched.
//
//  Same approach as run_ui_node.mjs: slice the real code out of app.html and
//  run it. No jsdom, no bundler, no install.
// ============================================================================

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "../../app.html"), "utf8");

function slice(startMarker, endMarker, label) {
  const a = src.indexOf(startMarker), b = src.indexOf(endMarker, a);
  if (a < 0 || b < 0) { console.error(`Could not locate ${label} in app.html`); process.exit(1); }
  return src.slice(a, b);
}

const favBlock = slice("function favNorm(s){", "function prefAllows(e){", "favourite helpers");
// prefAllows is declared AFTER applyPrefs, so anchor its end on its own closing
// brace rather than on a comment that appears earlier in the file.
const prefAllowsStart = src.indexOf("function prefAllows(e){");
const prefAllowsBlock = src.slice(prefAllowsStart, src.indexOf("\n}", src.indexOf("return true;", prefAllowsStart)) + 2);
const geBlock = slice("GE.decToAm=function(d)", "GE.bisect=function", "GE price helpers");

let store = {};
const sandbox = {
  console, Math, JSON, String, Number, Object, Array, isFinite, Date,
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  },
  GE: {},
  PREF_DEFAULTS: { sports: {}, hideNoSharp: false, favTeams: [], favOnly: false, oddsFormat: "american" },
  prefs() {
    try {
      const p = JSON.parse(sandbox.localStorage.getItem("edgedesk_prefs") || "{}");
      const o = {}; for (const k in sandbox.PREF_DEFAULTS) o[k] = (p[k] !== undefined ? p[k] : sandbox.PREF_DEFAULTS[k]);
      return o;
    } catch (e) { return JSON.parse(JSON.stringify(sandbox.PREF_DEFAULTS)); }
  },
  isSoftAnchor: () => false,
  window: {},
  stEsc: (x) => String(x == null ? "" : x),
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(geBlock, sandbox, { filename: "app.html:GE" });
vm.runInContext(favBlock + "\n" + prefAllowsBlock, sandbox, { filename: "app.html:prefs" });

const setPrefs = (o) => { store["edgedesk_prefs"] = JSON.stringify(o); };

let pass = 0; const fails = [];
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { fails.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${e.message}`); }
};
const ok = (v, m) => { if (!v) throw new Error(m || "expected truthy"); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || ""} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

const GAME = { home_team: "Boston Red Sox", away_team: "New York Yankees", sport_title: "MLB" };
const OTHER = { home_team: "Chicago Cubs", away_team: "St. Louis Cardinals", sport_title: "MLB" };

/* ---- favourite teams ----------------------------------------------------- */
t("team names match loosely on case, spacing and punctuation", () => {
  eq(sandbox.favNorm("Boston Red Sox"), "boston red sox");
  eq(sandbox.favNorm("ST. LOUIS  CARDINALS"), "st louis cardinals");
});

t("a favourite is detected on either side of the fixture", () => {
  setPrefs({ favTeams: ["Boston Red Sox"] });
  ok(sandbox.edgeIsFav(GAME), "home side");
  setPrefs({ favTeams: ["New York Yankees"] });
  ok(sandbox.edgeIsFav(GAME), "away side");
  setPrefs({ favTeams: ["Chicago Cubs"] });
  ok(!sandbox.edgeIsFav(GAME), "unrelated team must not match");
});

t("a favourite fixture is marked with a star", () => {
  setPrefs({ favTeams: ["Boston Red Sox"] });
  ok(sandbox.favStar(GAME).includes("fav-star"));
  eq(sandbox.favStar(OTHER), "", "a non-favourite gets no marker");
});

t("FAVOURITES-ONLY ACTUALLY FILTERS THE BOARD", () => {
  setPrefs({ favTeams: ["Boston Red Sox"], favOnly: true });
  ok(sandbox.prefAllows(GAME), "the favourite fixture survives");
  ok(!sandbox.prefAllows(OTHER), "everything else is filtered out — this is the real effect");
});

t("favourites-only with an EMPTY list cannot blank the board", () => {
  setPrefs({ favTeams: [], favOnly: true });
  ok(sandbox.prefAllows(GAME));
  ok(sandbox.prefAllows(OTHER));
});

t("favourites off changes nothing", () => {
  setPrefs({ favTeams: ["Boston Red Sox"], favOnly: false });
  ok(sandbox.prefAllows(GAME));
  ok(sandbox.prefAllows(OTHER), "marking a team must not silently filter");
});

t("the existing sport filter still works alongside favourites", () => {
  setPrefs({ sports: { MLB: true }, favTeams: [], favOnly: false });
  ok(sandbox.prefAllows(GAME));
  ok(!sandbox.prefAllows({ home_team: "A", away_team: "B", sport_title: "NFL" }),
    "the pre-existing sports pref must be untouched by this change");
});

/* ---- odds format --------------------------------------------------------- */
t("decToAm STILL RETURNS THE SAME NUMBER — the ledger depends on it", () => {
  eq(sandbox.GE.decToAm(2.15), 115);
  eq(sandbox.GE.decToAm(1.80), -125);
  eq(sandbox.GE.decToAm(2.00), 100);
});

t("American is the default and matches the old inline formatting exactly", () => {
  setPrefs({ oddsFormat: "american" }); sandbox.GE.setOddsFormat("american");
  eq(sandbox.GE.fmtPrice(2.15), "+115");
  eq(sandbox.GE.fmtPrice(1.80), "-125");
});

t("decimal format renders the decimal price", () => {
  sandbox.GE.setOddsFormat("decimal");
  eq(sandbox.GE.fmtPrice(2.15), "2.15");
  eq(sandbox.GE.fmtPrice(1.8), "1.80");
});

t("fractional format reduces to lowest terms", () => {
  sandbox.GE.setOddsFormat("fractional");
  eq(sandbox.GE.fmtPrice(2.5), "3/2");
  eq(sandbox.GE.fmtPrice(3.0), "2/1");
  eq(sandbox.GE.fmtPrice(1.8), "4/5");
  eq(sandbox.GE.fmtPrice(2.0), "1/1", "evens");
});

t("an unusable price is a dash in every format", () => {
  for (const f of ["american", "decimal", "fractional"]) {
    sandbox.GE.setOddsFormat(f);
    eq(sandbox.GE.fmtPrice(null), "—", f);
    eq(sandbox.GE.fmtPrice(0), "—", f);
    eq(sandbox.GE.fmtPrice(1), "—", f);
    eq(sandbox.GE.fmtPrice("abc"), "—", f);
  }
});

t("fmtAm formats an already-American number without re-deriving it", () => {
  sandbox.GE.setOddsFormat("american");
  eq(sandbox.GE.fmtAm(115), "+115");
  eq(sandbox.GE.fmtAm(-125), "-125");
  eq(sandbox.GE.fmtAm(null), "—");
});

t("a probability renders through the same formatter", () => {
  sandbox.GE.setOddsFormat("american");
  eq(sandbox.GE.fmtProb(0.55), sandbox.GE.fmtPrice(1 / 0.55));
  eq(sandbox.GE.fmtProb(0), "—");
  eq(sandbox.GE.fmtProb(null), "—");
});

console.log(`\n${pass}/${pass + fails.length} passed`);
if (fails.length) { console.log(`\x1b[31m${fails.length} FAILED\x1b[0m`); process.exit(1); }
console.log("\x1b[32mall green\x1b[0m");
