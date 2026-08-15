#!/usr/bin/env node
// ============================================================================
//  FILE:  supabase/tests/run_ui_node.mjs
//  RUN:   node supabase/tests/run_ui_node.mjs
//
//  Executes the UFC Live Fight Center renderers straight out of app.html.
//
//  WHY THIS EXISTS. app.html is a single 1.2MB file with no build step and no
//  test runner, so the usual answer is that its UI is never executed until a
//  user loads it. That is a bad trade for a screen whose entire promise is
//  "a number you see was really published, and a blank really means unknown".
//
//  So this harness slices the deep-layer block out of app.html, supplies the
//  handful of globals it depends on, and renders it against mock data —
//  asserting on the produced HTML. It checks the one rule that matters most:
//
//      A NULL STATISTIC RENDERS AS A DASH, NEVER AS A ZERO.
//
//  It is deliberately dependency-free: no jsdom, no bundler, no npm install.
// ============================================================================

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const APP = resolve(here, "../../app.html");
const src = readFileSync(APP, "utf8");

const START = "UFC LIVE FIGHT CENTER — DEEP LAYER";
const END = "\nrenderLedger();loadEdges();";
const a = src.indexOf(START), b = src.indexOf(END, a);
if (a < 0 || b < 0) {
  console.error("Could not locate the UFC deep-layer block in app.html.");
  process.exit(1);
}
const block = src.slice(src.lastIndexOf("/*", a), b);

/* ---- the globals the block reaches for ---------------------------------- */
const esc = (x) => String(x == null ? "" : x)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const sandbox = {
  console,
  UFC: { byId: {}, mode: "live", deep: null, market: null },
  $: () => null,
  stEsc: esc, rsEsc: esc,
  ago: () => "3s ago",
  sbGetUfc: async () => [],
  sbGet: async () => [],
  BOARD_FLAG_COLS: "flagged_at,flagged_edge,flagged_best_dec,flagged_best_book",
  GE: {
    decToAm: (d) => (d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1))),
    fmtPrice(d) { if (d == null || !isFinite(+d) || +d <= 1) return "—";
      const a = this.decToAm(+d); return (a > 0 ? "+" : "") + a; },
  },
  anchorOf: () => ({ kind: "sharp", short: "sharp anchored", why: "Pinnacle quoted this selection." }),
  isFlaggedSignal: (e) => !!(e && e.flagged_at),
  setTimeout, clearTimeout, Date, Math, JSON, String, Number, Object, Array, isFinite, encodeURIComponent,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(block, sandbox, { filename: "app.html:ufc-deep" });

/* ---- assertions ---------------------------------------------------------- */
let pass = 0; const fails = [];
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { fails.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${e.message}`); }
};
const ok = (v, m) => { if (!v) throw new Error(m || "expected truthy"); };
const has = (h, n, m) => ok(String(h).includes(n), m || `expected HTML to contain ${JSON.stringify(n)}`);
const lacks = (h, n, m) => ok(!String(h).includes(n), m || `expected HTML NOT to contain ${JSON.stringify(n)}`);
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m ? m + " — " : ""}expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

const DASH = "—";
const U = sandbox.UFC;

/* ---- formatting rules ---------------------------------------------------- */
t("a null count renders as a dash, never as 0", () => {
  ok(sandbox.ufcNum(null) === DASH);
  ok(sandbox.ufcNum(undefined) === DASH);
  ok(sandbox.ufcNum(0) === "0", "an explicit zero is real data and must show as 0");
});

t("an unpublished pair renders as a dash", () => {
  ok(sandbox.ufcPairTxt(null, null) === DASH);
  ok(sandbox.ufcPairTxt(38, 71) === "38/71");
  ok(sandbox.ufcPairTxt(null, 71) === DASH + "/71", "half a pair is still half unknown");
});

t("accuracy is not computed against a missing or zero denominator", () => {
  ok(sandbox.ufcAccTxt(38, 71) === "54%");
  ok(sandbox.ufcAccTxt(null, 71) === DASH);
  ok(sandbox.ufcAccTxt(0, 0) === DASH, "0 of 0 is not 0% — it is unknown");
});

t("control time formats as a clock", () => {
  ok(sandbox.ufcTimeTxt(134) === "2:14");
  ok(sandbox.ufcTimeTxt(0) === "0:00");
  ok(sandbox.ufcTimeTxt(null) === DASH);
});

t("a leader is never crowned against a blank", () => {
  ok(sandbox.ufcLead(5, 3) === "a");
  ok(sandbox.ufcLead(3, 5) === "b");
  ok(sandbox.ufcLead(5, null) === "", "unknown is not 'less than'");
  ok(sandbox.ufcLead(null, null) === "");
});

/* ---- the scorecard ------------------------------------------------------- */
const FULL = {
  sig_strikes_landed: 38, sig_strikes_attempted: 71,
  total_strikes_landed: 52, total_strikes_attempted: 89,
  head_strikes_landed: 20, head_strikes_attempted: 40,
  takedowns_landed: 2, takedowns_attempted: 4,
  control_seconds: 134, knockdowns: 1, submission_attempts: 0, reversals: 0,
};
const SPARSE = { sig_strikes_landed: 24, sig_strikes_attempted: 61 };

t("the scorecard renders every contract row from real values", () => {
  const h = sandbox.ufcStatBlockHTML(FULL, SPARSE);
  has(h, "38/71"); has(h, "24/61"); has(h, "54%");
  has(h, "2:14", "control time");
  has(h, "Sig. strikes"); has(h, "Takedowns"); has(h, "Knockdowns"); has(h, "Reversals");
  has(h, "Head"); has(h, "Distance"); has(h, "Clinch"); has(h, "Ground");
});

t("FIELDS THE SOURCE NEVER PUBLISHED RENDER AS DASHES, NOT ZEROS", () => {
  const h = sandbox.ufcStatBlockHTML(SPARSE, SPARSE);
  // neither corner published takedowns / control / knockdowns
  has(h, DASH, "unpublished fields must show a dash");
  const kd = h.slice(h.indexOf("Knockdowns") - 260, h.indexOf("Knockdowns") + 260);
  lacks(kd, ">0<", "a knockdown count nobody published must not render as 0");
});

t("an explicit zero from the source IS shown as zero", () => {
  const h = sandbox.ufcStatBlockHTML({ knockdowns: 0 }, { knockdowns: 2 });
  has(h, ">0<", "0 knockdowns is a real observation and must not be hidden");
});

/* ---- rounds -------------------------------------------------------------- */
t("round statistics render a total block and one block per round", () => {
  U.deep = { rounds: { f1: [
    { fight_id: "f1", corner: "red", round: 0, is_cumulative: true, ...FULL },
    { fight_id: "f1", corner: "blue", round: 0, is_cumulative: true, ...SPARSE },
    { fight_id: "f1", corner: "red", round: 1, round_status: "complete", sig_strikes_landed: 18, sig_strikes_attempted: 33 },
    { fight_id: "f1", corner: "blue", round: 1, round_status: "complete", sig_strikes_landed: 12, sig_strikes_attempted: 29 },
    { fight_id: "f1", corner: "red", round: 2, round_status: "in", sig_strikes_landed: 20, sig_strikes_attempted: 38 },
  ] }, snaps: {}, fights: {}, ev: null, health: null, ok: true, why: "" };
  const h = sandbox.ufcRoundsHTML("f1");
  has(h, "Fight total"); has(h, "Round 1"); has(h, "Round 2");
  has(h, "18/33"); has(h, "complete");
  lacks(h, "Round 0", "round 0 is the fight total by contract, not a round");
});

t("no round rows yet says so without claiming zeros", () => {
  U.deep = { rounds: { f1: [] }, snaps: {}, fights: {}, ev: null, health: null, ok: true, why: "" };
  const h = sandbox.ufcRoundsHTML("f1");
  has(h, "not that nothing happened");
});

t("an unreadable round table names the migration rather than blaming the feed", () => {
  U.deep = { rounds: { f1: null }, snaps: {}, fights: {}, ev: null, health: null, ok: true, why: "" };
  has(sandbox.ufcRoundsHTML("f1"), "ufc_live_v2.sql");
});

/* ---- derived analytics --------------------------------------------------- */
t("momentum reports observed change and is labelled EdgeDesk-derived", () => {
  U.deep = { rounds: {}, snaps: { f1: [
    { corner: "red", round: 2, captured_at: "2026-08-15T20:00:00Z", sig_strikes_landed: 10, takedowns_landed: 0, control_seconds: 0, knockdowns: 0, submission_attempts: 0 },
    { corner: "red", round: 2, captured_at: "2026-08-15T20:01:00Z", sig_strikes_landed: 28, takedowns_landed: 1, control_seconds: 42, knockdowns: 1, submission_attempts: 0 },
    { corner: "blue", round: 2, captured_at: "2026-08-15T20:00:00Z", sig_strikes_landed: 8, takedowns_landed: 0, control_seconds: 0, knockdowns: 0, submission_attempts: 0 },
    { corner: "blue", round: 2, captured_at: "2026-08-15T20:01:00Z", sig_strikes_landed: 12, takedowns_landed: 0, control_seconds: 0, knockdowns: 0, submission_attempts: 1 },
  ] }, fights: {}, ev: null, health: null, ok: true, why: "" };
  const h = sandbox.ufcMomentumHTML("f1", { round: 2 });
  has(h, "+18 sig"); has(h, "+1 TD"); has(h, "+1 KD"); has(h, "+1 sub att");
  has(h, "EdgeDesk-derived");
  has(h, "not a judging score", "EdgeDesk must not imply an official round score");
});

t("momentum stays silent with too few snapshots to difference", () => {
  U.deep = { rounds: {}, snaps: { f1: [{ corner: "red", round: 1, captured_at: "2026-08-15T20:00:00Z", sig_strikes_landed: 5 }] }, fights: {}, ev: null, health: null, ok: true, why: "" };
  ok(sandbox.ufcMomentumHTML("f1", { round: 1 }) === "", "one point is not a trend");
});

t("pace compares live rate to the career baseline and labels it derived", () => {
  U.byId = { r1: { c: { slpm: 4.0, takedown_avg: 2.0 } } };
  U.deep = { rounds: { f1: [
    { corner: "red", round: 0, sig_strikes_landed: 60, takedowns_landed: 2 },
  ] }, snaps: {}, fights: {}, ev: null, health: null, ok: true, why: "" };
  const h = sandbox.ufcPaceHTML({ fight_id: "f1", elapsed_seconds: 600, red_fighter_id: "r1", red_name: "Red Guy" });
  has(h, "EdgeDesk-derived");
  has(h, "6.00", "60 sig strikes over 10 minutes is 6.00/min");
  has(h, "vs 4.00", "against a 4.0 career baseline");
  has(h, "+50%");
});

t("a fighter with no career row shows no baseline rather than a substituted one", () => {
  U.byId = {};
  U.deep = { rounds: { f1: [{ corner: "red", round: 0, sig_strikes_landed: 60 }] }, snaps: {}, fights: {}, ev: null, health: null, ok: true, why: "" };
  const h = sandbox.ufcPaceHTML({ fight_id: "f1", elapsed_seconds: 600, red_fighter_id: "nobody", red_name: "Red" });
  has(h, "no career baseline");
});

t("pace refuses to compute a rate over a few seconds", () => {
  U.deep = { rounds: { f1: [{ corner: "red", round: 0, sig_strikes_landed: 3 }] }, snaps: {}, fights: {}, ev: null, health: null, ok: true, why: "" };
  ok(sandbox.ufcPaceHTML({ fight_id: "f1", elapsed_seconds: 12, red_fighter_id: "r1" }) === "",
    "a per-minute rate over 12 seconds is noise, not a read");
});

t("the timeline draws an SVG from stored snapshots", () => {
  U.deep = { rounds: {}, snaps: { f1: [
    { corner: "red", round: 1, captured_at: "2026-08-15T20:00:00Z", sig_strikes_landed: 2 },
    { corner: "red", round: 1, captured_at: "2026-08-15T20:00:30Z", sig_strikes_landed: 9 },
    { corner: "blue", round: 1, captured_at: "2026-08-15T20:00:00Z", sig_strikes_landed: 1 },
    { corner: "blue", round: 1, captured_at: "2026-08-15T20:00:30Z", sig_strikes_landed: 6 },
  ] }, fights: {}, ev: null, health: null, ok: true, why: "" };
  const h = sandbox.ufcTimelineHTML("f1");
  has(h, "<svg"); has(h, "<path"); has(h, "live_fight_snapshots");
  has(h, "reconstructed at any earlier point");
});

/* ---- market -------------------------------------------------------------- */
t("market context renders opening, current, movement and the existing signal", () => {
  U.market = { ok: true, at: Date.now(), byName: {
    "red guy": { selection: "Red Guy", first_best_dec: 2.15, best_dec: 1.80, best_book: "DK",
      sharp_fair: 0.55, edge: 0.021, n_books: 7, has_sharp: true, flagged_at: "2026-08-15T19:00:00Z", flagged_best_dec: 1.8 },
  } };
  const h = sandbox.ufcMarketHTML({ red_name: "Red Guy", blue_name: "Blue Guy" });
  has(h, "Opened"); has(h, "+115"); has(h, "Current"); has(h, "-125");
  has(h, "Movement"); has(h, "cents");
  has(h, "flagged"); has(h, "sharp anchored");
  has(h, "No stored quote.", "the unmatched fighter says so rather than borrowing a price");
  has(h, "not recomputed here", "the market block must declare it consumes the existing engine");
});

t("no MMA signal at all explains itself without a placeholder price", () => {
  U.market = { ok: true, at: Date.now(), byName: {} };
  const h = sandbox.ufcMarketHTML({ red_name: "A", blue_name: "B" });
  has(h, "shows nothing rather than a placeholder price");
});

/* ---- the panel and diagnostics ------------------------------------------- */
t("THE DEEP PANEL RENDERS NOTHING WHEN THERE IS NO DEEP ROW", () => {
  U.deep = { rounds: {}, snaps: {}, fights: {}, ev: null, health: null, ok: true, why: "" };
  ok(sandbox.ufcDeepPanelHTML({ fight_id: "unknown" }) === "",
    "this is what keeps the whole layer additive: no deep data, no change to the existing card");
});

t("a collapsed panel shows identity, result and freshness", () => {
  U.liveOpen = {};
  U.deep = { rounds: {}, snaps: {}, fights: { f1: {
    fight_id: "f1", weight_class: "Lightweight", scheduled_rounds: 5, referee: "Herb Dean",
    is_title: true, status: "post", method: "KO/TKO", end_round: 2, end_time: "3:14",
    source: "sportradar", source_freshness_seconds: 4, updated_at: "2026-08-15T20:00:00Z",
  } }, ev: null, health: null, ok: true, why: "" };
  const h = sandbox.ufcDeepPanelHTML({ fight_id: "f1" });
  has(h, "Herb Dean"); has(h, "5 rounds"); has(h, "TITLE");
  has(h, "KO/TKO"); has(h, "R2"); has(h, "3:14");
  has(h, "source state 0:04 old", "provider staleness must be shown next to our write stamp");
});

t("a bout the source publishes no statistics for says exactly that", () => {
  U.liveOpen = {};
  U.deep = { rounds: {}, snaps: {}, fights: { f1: { fight_id: "f1", status: "in", stats_available: false } },
    ev: null, health: null, ok: true, why: "" };
  has(sandbox.ufcDeepPanelHTML({ fight_id: "f1" }), "publishes no live statistics");
});

t("diagnostics separate 'no event' from 'source broken' from 'no stats'", () => {
  const verdict = (health) => {
    U.deep = { rounds: {}, snaps: {}, fights: {}, ev: null, health, ok: true, why: "" };
    return sandbox.ufcDiagHTML();
  };
  has(verdict({ provider_verified: false, api_failures: 3 }), "The source is failing");
  has(verdict({ provider_verified: false, api_failures: 0 }), "response shape has probably changed");
  has(verdict({ provider_verified: true, events_active: 0 }), "Nothing is wrong");
  has(verdict({ provider_verified: true, events_active: 1, fights_live_now: 0 }), "no bout is currently live");
  has(verdict({ provider_verified: true, events_active: 1, fights_live_now: 1, fights_live_with_stats: 0 }), "publishes no statistics for it yet");
  has(verdict({ provider_verified: true, events_active: 1, fights_live_now: 1, fights_live_with_stats: 1 }), "UI is failing to consume valid data");
});

t("an uninstalled migration is reported as not-installed, not as an outage", () => {
  U.deep = { rounds: {}, snaps: {}, fights: {}, ev: null, health: null, ok: false, why: "db 404" };
  const h = sandbox.ufcDiagHTML();
  has(h, "not installed"); has(h, "ufc_live_v2.sql");
  has(h, "nothing has been taken away");
});

t("unmapped source fields surface in the diagnostics", () => {
  U.deep = { rounds: {}, snaps: {}, fights: {}, ev: null, ok: true, why: "",
    health: { provider_verified: true, events_active: 1, fights_live_now: 1, fights_live_with_stats: 1,
      unmapped_stat_keys: { significant_strikes_delivered: 12 } } };
  const h = sandbox.ufcDiagHTML();
  has(h, "significant_strikes_delivered");
  has(h, "STAT_ALIASES", "the diagnostic must say how to fix it");
});

t("event metadata renders venue, location and card progress", () => {
  U.deep = { rounds: {}, snaps: {}, fights: {}, health: null, ok: true, why: "",
    ev: { venue: "T-Mobile Arena", location: "Las Vegas, NV", fights_total: 12, fights_completed: 7, fights_active: 1 } };
  const h = sandbox.ufcEventMetaHTML({ event_id: "e1" });
  has(h, "T-Mobile Arena"); has(h, "Las Vegas, NV"); has(h, "7 of 12 bouts complete"); has(h, "1 live now");
});

t("name normalization matches the Edge Function's, so market joins line up", () => {
  ok(sandbox.ufcNormName("José Aldó Jr.") === "jose aldo");
  ok(sandbox.ufcNormName("Conor McGregor") === "conor mcgregor");
});


/* ---- pre-fight CLV -------------------------------------------------------
   The bridge from a bout to the existing odds engine. These assert the two
   things that were actually broken: that the tile reads a condition at all,
   and that a live price is never mistaken for a close. */
const BOUT = { fight_id: "f9", red_name: "Myktybek Orolbai", blue_name: "Jeremiah Wells" };
const BELL = "2026-08-15T22:00:00Z";
const SIG = {
  sig_key: "ev1|h2h|Myktybek Orolbai|", event_id: "ev1", market: "h2h",
  selection: "Myktybek Orolbai", commence_time: BELL,
  home_team: "Myktybek Orolbai", away_team: "Jeremiah Wells",
  flagged_at: "2026-08-15T16:00:00Z", flagged_best_dec: 1.813, flagged_sharp_fair: 0.585,
  first_best_dec: 1.90, first_sharp_fair: 0.57, first_seen_at: "2026-08-15T12:00:00Z",
  best_dec: 1.74, sharp_fair: 0.60, n_books: 8, has_sharp: true, first_has_sharp: true,
  closing_sharp_fair: null, closed_at: null,
};
const setMarket = (rows) => {
  const pair = {};
  (rows || []).forEach((r) => {
    const k = sandbox.ufcPairKey(r.home_team, r.away_team);
    (pair[k] = pair[k] || { event_id: r.event_id, rows: [] }).rows.push(r);
  });
  U.market = { ok: true, at: Date.now(), byName: {}, byPair: pair };
};

t("a bout matches its odds event by unordered fighter-name pair", () => {
  ok(sandbox.ufcPairKey("Jeremiah Wells", "Myktybek Orolbai")
     === sandbox.ufcPairKey("Myktybek Orolbai", "Jeremiah Wells"),
     "corner assignment must not change the key");
  eq(sandbox.ufcPairKey("A", null), "", "a half-known fixture matches nothing");
});

t("entry is the flagged price, matching the grader's definition", () => {
  const e = sandbox.ufcEntryOf(SIG);
  eq(e.dec, 1.813); eq(e.kind, "flagged");
  const noFlag = sandbox.ufcEntryOf({ ...SIG, flagged_at: null, flagged_best_dec: null });
  eq(noFlag.dec, 1.90); eq(noFlag.kind, "opening", "falls back to the opener, as close/index.ts does");
  eq(sandbox.ufcEntryOf({}), null);
});

t("A TICK AFTER THE BELL IS NEVER USED AS A CLOSE", () => {
  const ticks = [
    { created_at: "2026-08-15T21:50:00Z", sharp_fair: 0.605 },   // last pre-fight
    { created_at: "2026-08-15T22:10:00Z", sharp_fair: 0.900 },   // LIVE — must be ignored
  ];
  const c = sandbox.ufcCloseOf(SIG, ticks);
  eq(c.fair, 0.605, "the live tick must not become the close");
  ok(c.qualified);
});

t("the close is the LAST qualifying pre-fight tick, not the first", () => {
  const c = sandbox.ufcCloseOf(SIG, [
    { created_at: "2026-08-15T18:00:00Z", sharp_fair: 0.58 },
    { created_at: "2026-08-15T21:50:00Z", sharp_fair: 0.605 },
  ]);
  eq(c.fair, 0.605);
});

t("closing_sharp_fair from the close pipeline takes precedence over ticks", () => {
  const c = sandbox.ufcCloseOf({ ...SIG, closing_sharp_fair: 0.62, closed_at: BELL },
    [{ created_at: "2026-08-15T21:50:00Z", sharp_fair: 0.605 }]);
  eq(c.fair, 0.62); eq(c.src, "close pipeline");
});

t("a stale final capture is UNQUALIFIED, not silently called a close", () => {
  const c = sandbox.ufcCloseOf(SIG, [{ created_at: "2026-08-15T10:00:00Z", sharp_fair: 0.55 }]);
  ok(c !== null, "it is found");
  ok(!c.qualified, "but 12h before the bell is not a close");
});

t("CLV is the closing fair against the entry price", () => {
  const entry = sandbox.ufcEntryOf(SIG);
  const close = sandbox.ufcCloseOf(SIG, [{ created_at: "2026-08-15T21:50:00Z", sharp_fair: 0.605 }]);
  const clv = sandbox.ufcClvOf(entry, close);
  // 0.605 * 1.813 - 1 = +0.09687
  ok(Math.abs(clv - 0.09687) < 1e-4, `expected ~+9.69%, got ${(clv * 100).toFixed(2)}%`);
});

t("an unqualified close yields no CLV rather than a number", () => {
  const entry = sandbox.ufcEntryOf(SIG);
  const stale = sandbox.ufcCloseOf(SIG, [{ created_at: "2026-08-15T10:00:00Z", sharp_fair: 0.55 }]);
  eq(sandbox.ufcClvOf(entry, stale), null);
  eq(sandbox.ufcClvOf(entry, null), null);
});

t("THE TILE RENDERS REAL CLV — it is no longer a hardcoded 'not active'", () => {
  setMarket([SIG]);
  U.deep = { rounds: {}, snaps: {}, fights: {}, ticks: { [SIG.sig_key]: [{ created_at: "2026-08-15T21:50:00Z", sharp_fair: 0.605 }] },
    ev: null, health: null, ok: true, why: "" };
  const h = sandbox.ufcClvHTML(BOUT);
  has(h, "+9.69%");
  has(h, "entry"); has(h, "close");
  has(h, "EdgeDesk-derived");
  lacks(h, "needs live capture", "the old unconditional caption must be gone");
  has(h, "never used as a close", "the rule must be stated where the number is shown");
});

t("no stored market says so, and names what to check", () => {
  setMarket([]);
  U.deep = { rounds: {}, snaps: {}, fights: {}, ticks: {}, ev: null, health: null, ok: true, why: "" };
  const h = sandbox.ufcClvHTML(BOUT);
  has(h, "no market");
  has(h, "mma_mixed_martial_arts", "naming the sport key makes it checkable");
});

t("before the bell the row reads pending, not zero and not unavailable", () => {
  setMarket([SIG]);
  U.deep = { rounds: {}, snaps: {}, fights: {}, ticks: { [SIG.sig_key]: [] }, ev: null, health: null, ok: true, why: "" };
  const h = sandbox.ufcClvHTML(BOUT);
  has(h, "pending"); has(h, "closes at first bell");
});

t("an unqualified close is reported as such in the tile", () => {
  setMarket([SIG]);
  U.deep = { rounds: {}, snaps: {}, fights: {}, ticks: { [SIG.sig_key]: [{ created_at: "2026-08-15T10:00:00Z", sharp_fair: 0.55 }] },
    ev: null, health: null, ok: true, why: "" };
  has(sandbox.ufcClvHTML(BOUT), "no qualified closing reference");
});

t("the model tile stays gated — that gate is still true", () => {
  setMarket([SIG]);
  U.deep = { rounds: {}, snaps: {}, fights: {}, ticks: {}, ev: null, health: null, ok: true, why: "" };
  has(sandbox.ufcClvHTML(BOUT), "needs UFC model");
});

t("non-moneyline markets on the same bout are included", () => {
  const tot = { ...SIG, sig_key: "ev1|totals|Over|1.5", market: "totals", selection: "Over", point: 1.5 };
  setMarket([SIG, tot]);
  U.deep = { rounds: {}, snaps: {}, fights: {}, ticks: {}, ev: null, health: null, ok: true, why: "" };
  const h = sandbox.ufcClvHTML(BOUT);
  has(h, "Over 1.5", "a total priced on the same fixture must appear");
  has(h, "totals");
});

console.log(`\n${pass}/${pass + fails.length} passed`);
if (fails.length) { console.log(`\x1b[31m${fails.length} FAILED\x1b[0m`); process.exit(1); }
console.log("\x1b[32mall green\x1b[0m");
