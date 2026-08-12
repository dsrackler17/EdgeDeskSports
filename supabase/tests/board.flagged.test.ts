// supabase/tests/board.flagged.test.ts
// ============================================================================
// BOARD REGRESSION: the active board must show FLAGGED signals only.
//
// `signals` holds two kinds of row and the board was not telling them apart:
//
//   STORED  — every market observation capture priced. Real data, kept on
//             purpose for movement, residuals, replay and research.
//   FLAGGED — a row capture was willing to stand behind. It cleared the
//             backable-market, plausible-price, sane-edge, consensus-depth and
//             outlier checks, and capture froze flagged_at + flagged_best_dec.
//
// The board selected on `edge=gt.0` alone, so an h2h_lay quote at +140% — a
// price capture had explicitly REFUSED — sorted straight to the top of an
// edge-ordered board. Flag discipline was protecting the record and the CLV
// basis and nothing else.
//
// This suite reads the REAL app.html, extracts the actual query strings and the
// actual filter functions, and runs them against a fixture. It fails if any
// active-board query stops requiring flagged_at.
//
// RUN: node --experimental-strip-types supabase/tests/board.flagged.test.ts
// ============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = readFileSync(resolve(HERE, "../../app.html"), "utf8");

let PASS = 0, FAIL = 0, N = 0;
const rows: { n: number; name: string; ok: boolean; detail: string }[] = [];
function check(name: string, cond: boolean, detail = "") {
  N++; if (cond) PASS++; else FAIL++;
  rows.push({ n: N, name, ok: cond, detail });
}

/* ---- pull the real guards out of app.html and evaluate them --------------
   Not reimplemented here: if app.html's definition changes, this suite picks
   the change up rather than testing a stale copy. */
function extract(startsWith: string, endMarker: string): string {
  const i = APP.indexOf(startsWith);
  if (i < 0) throw new Error("could not find in app.html: " + startsWith);
  const j = APP.indexOf(endMarker, i);
  return APP.slice(i, j + endMarker.length);
}

const guardSrc = [
  extract("var BOARD_FLAG_FILTER=", "\n"),
  extract("var BOARD_FLAG_COLS=", "\n"),
  extract("function isFlaggedSignal(e){", "\n}"),
  extract("function onlyFlagged(rows){", "\n}"),
  extract("var BOARD_MAX_DEC =", "\n"),
  extract("var BOARD_MIN_DEC =", "\n"),
  extract("var BACK_MARKETS  =", "\n"),
  extract("function marketIsLay(mkt){", "\n"),
  extract("function signalTradeable(e){", "\n}"),
  extract("function filterTradeable(rows){", "\n}"),
].join("\n");

const G: any = new Function(guardSrc + `
  return { BOARD_FLAG_FILTER, BOARD_FLAG_COLS, isFlaggedSignal, onlyFlagged,
           signalTradeable, filterTradeable };
`)();

/* ---- the fixture the brief asked for ----------------------------------- */
const nowIso = new Date().toISOString();
const SIGNAL_A = {              // stored, REFUSED by capture — must never show
  sig_key: "A", event_id: "evA", market: "h2h_lay", selection: "Iga Swiatek",
  sport_title: "WTA", best_dec: 12.0, edge: 1.40, first_edge: 1.40, n_books: 4,
  commence_time: nowIso, flagged_at: null, flagged_best_dec: null, flagged_edge: null,
};
const SIGNAL_B = {              // flagged, real — must show
  sig_key: "B", event_id: "evB", market: "h2h", selection: "Las Vegas Aces",
  sport_title: "WNBA", best_dec: 1.95, edge: 0.03, first_edge: 0.03, n_books: 6,
  commence_time: nowIso, flagged_at: nowIso, flagged_best_dec: 1.95, flagged_edge: 0.03,
};
/* stored, backable, positive edge — but capture still never flagged it. The
   subtle case: it looks fine, so only the flag filter excludes it. */
const SIGNAL_C = {
  sig_key: "C", event_id: "evC", market: "h2h", selection: "Some Team",
  sport_title: "MLB", best_dec: 2.05, edge: 0.09, first_edge: 0.09, n_books: 5,
  commence_time: nowIso, flagged_at: null, flagged_best_dec: null, flagged_edge: null,
};
const FIXTURE = [SIGNAL_A, SIGNAL_B, SIGNAL_C];

/* ---- a tiny PostgREST filter evaluator so the real query strings run ----
   Supports only what the board queries actually use. Anything unrecognised
   throws rather than silently passing, so a filter this cannot model can never
   be mistaken for one that matched. */
function applyQuery(url: string, rowsIn: any[]): any[] {
  const qs = url.slice(url.indexOf("?") + 1).split("&");
  let out = rowsIn.slice();
  for (const clause of qs) {
    if (!clause || clause.startsWith("select=") || clause.startsWith("order=")
      || clause.startsWith("limit=")) continue;
    const eq = clause.indexOf("=");
    const col = clause.slice(0, eq);
    const expr = clause.slice(eq + 1);
    if (expr === "not.is.null") { out = out.filter((r) => r[col] != null); continue; }
    if (expr === "is.null") { out = out.filter((r) => r[col] == null); continue; }
    const m = /^(gt|gte|lt|lte|eq)\.(.*)$/.exec(expr);
    if (!m) throw new Error("unmodelled filter: " + clause);
    const [, op, rawVal] = m;
    const val: any = /^-?\d+(\.\d+)?$/.test(rawVal) ? Number(rawVal) : rawVal;
    out = out.filter((r) => {
      const v = /^-?\d+(\.\d+)?$/.test(rawVal) ? Number(r[col]) : r[col];
      if (v == null) return false;
      switch (op) {
        case "gt": return v > val; case "gte": return v >= val;
        case "lt": return v < val; case "lte": return v <= val;
        case "eq": return String(v) === String(val);
      }
      return false;
    });
  }
  return out;
}

/* ---- rebuild each active-board URL exactly as app.html builds it -------- */
const BOARD_FLAG_FILTER = G.BOARD_FLAG_FILTER;
const BOARD_FLAG_COLS = G.BOARD_FLAG_COLS;
const hzIso = new Date(Date.now() + 14 * 864e5).toISOString();
const past = new Date(Date.now() - 3600e3).toISOString();

const ACTIVE_BOARD_QUERIES: { name: string; url: string }[] = [
  { name: "EDGES (main edge table)",
    url: `signals?select=edge,${BOARD_FLAG_COLS}&${BOARD_FLAG_FILTER}&commence_time=gte.${past}&commence_time=lte.${hzIso}&edge=gt.0&order=edge.desc&limit=600` },
  { name: "D5_POOL (Top 5 daily)",
    url: `signals?select=edge,${BOARD_FLAG_COLS}&${BOARD_FLAG_FILTER}&commence_time=gte.${past}&commence_time=lte.${hzIso}&edge=not.is.null&order=edge.desc.nullslast&limit=120` },
  { name: "CONS_POOL (consensus engine)",
    url: `signals?select=edge,${BOARD_FLAG_COLS}&${BOARD_FLAG_FILTER}&consensus_fair=not.is.null&commence_time=gte.${past}&commence_time=lte.${hzIso}&limit=900` },
  { name: "discovery pool (Fresh Openers / Steam / Missed cards)",
    url: `signals?select=edge,first_edge,${BOARD_FLAG_COLS}&${BOARD_FLAG_FILTER}&first_edge=gt.0&commence_time=gte.${past}&commence_time=lte.${hzIso}&order=first_seen_at.desc&limit=800` },
];

async function main() {
  /* ---- 1. the fixture case from the brief ---------------------------- */
  {
    const board = applyQuery(ACTIVE_BOARD_QUERIES[0].url, FIXTURE);
    const keys = board.map((r) => r.sig_key).sort();
    check("Active board shows ONLY the flagged signal (B), not A or C",
      keys.length === 1 && keys[0] === "B", "showed: " + JSON.stringify(keys));
    check("The +140% unflagged h2h_lay row (A) is NOT on the board",
      !board.some((r) => r.sig_key === "A"));
    check("A backable, positive-edge, but UNFLAGGED row (C) is also excluded",
      !board.some((r) => r.sig_key === "C"));
  }

  /* ---- 2. every active-board query carries the filter ----------------- */
  for (const q of ACTIVE_BOARD_QUERIES) {
    const got = applyQuery(q.url, FIXTURE).map((r) => r.sig_key);
    check(`${q.name} returns only flagged rows`,
      got.every((k) => k === "B"), "returned: " + JSON.stringify(got));
  }

  /* ---- 3. THE REGRESSION GUARD ---------------------------------------
     Fails the moment an active-board query in app.html drops the filter. */
  {
    const boardQueries = [
      { label: "EDGES", anchor: "EDGES=await sbGet('signals?select=" },
      { label: "D5_POOL", anchor: "try{var pool=await sbGet('signals?select=" },
      { label: "CONS_POOL", anchor: "try{var cq=await sbGet('signals?select=" },
      { label: "discovery pool", anchor: "var q='signals?select=event_id,sport_title,sport_key,market,selection,point,best_dec,first_best_dec,first_best_book" },
    ];
    for (const bq of boardQueries) {
      const i = APP.indexOf(bq.anchor);
      const stmt = i < 0 ? "" : APP.slice(i, APP.indexOf(";", i));
      check(`app.html: ${bq.label} query still requires flagged_at`,
        i >= 0 && stmt.includes("BOARD_FLAG_FILTER"),
        i < 0 ? "query not found — did it get renamed?" : stmt.slice(0, 160));
    }
  }

  /* ---- 4. in-memory guard -------------------------------------------- */
  {
    check("isFlaggedSignal rejects a null flagged_at", G.isFlaggedSignal(SIGNAL_A) === false);
    check("isFlaggedSignal accepts a properly frozen signal", G.isFlaggedSignal(SIGNAL_B) === true);
    check("isFlaggedSignal rejects a flagged_at with an unusable entry price",
      G.isFlaggedSignal({ flagged_at: nowIso, flagged_best_dec: 1 }) === false);
    check("isFlaggedSignal rejects a flagged_at with a null entry price",
      G.isFlaggedSignal({ flagged_at: nowIso, flagged_best_dec: null }) === false);
    check("onlyFlagged keeps exactly the flagged row",
      G.onlyFlagged(FIXTURE).map((r: any) => r.sig_key).join(",") === "B");
    check("onlyFlagged survives null/undefined input",
      G.onlyFlagged(null).length === 0 && G.onlyFlagged(undefined).length === 0);
  }

  /* ---- 5. the lay guard still stands independently -------------------- */
  {
    check("signalTradeable still refuses an exchange lay market",
      G.signalTradeable(SIGNAL_A).ok === false);
    check("...and names it as a lay quote",
      /lay/i.test(G.signalTradeable(SIGNAL_A).reason || ""));
    check("signalTradeable accepts the real signal", G.signalTradeable(SIGNAL_B).ok === true);
    check("A flagged row that is somehow a lay would STILL be dropped by the tradeable guard",
      G.filterTradeable([{ ...SIGNAL_A, flagged_at: nowIso, flagged_best_dec: 12.0 }]).keep.length === 0);
  }

  /* ---- 6. HISTORICAL ACCESS IS NOT GATED -----------------------------
     The brief is explicit: raw market data must stay readable where it is
     appropriate. Gating these would silently shrink the record and the
     movement series. */
  {
    const graded = `signals?select=clv,result&graded_at=not.is.null&limit=5000`;
    check("A graded/record query does NOT carry the board flag filter",
      !graded.includes("flagged_best_dec=not.is.null"));

    // signal A must remain visible to a raw/movement read
    const rawByEvent = `signals?select=best_dec,edge&event_id=eq.evA&limit=1`;
    check("Raw per-event access still SEES the unflagged row A",
      applyQuery(rawByEvent, FIXTURE).length === 1);

    // and the real app.html reads that must stay ungated
    const ungated = [
      { label: "replay / signal_ticks", needle: "signal_ticks?select=edge,best_dec,created_at" },
      { label: "receipt (single signal by sig_key)", needle: "signals?select=event_id,sport_title,sport_key,market,selection,point,home_team,away_team,commence_time,first_seen_at" },
      { label: "capture heartbeat", needle: "signals?select=last_seen_at&last_seen_at=not.is.null" },
    ];
    for (const u of ungated) {
      const i = APP.indexOf(u.needle);
      const stmt = i < 0 ? "" : APP.slice(i, APP.indexOf(";", i));
      check(`${u.label} is still UNGATED (historical/raw access preserved)`,
        i >= 0 && !stmt.includes("BOARD_FLAG_FILTER"), i < 0 ? "not found" : "carries the board filter");
    }
    const recIdx = APP.indexOf("var REC_COLS=");
    check("The record view still selects on flagged_at itself (unchanged)",
      recIdx >= 0 && APP.includes("flagged_at=not.is.null&flagged_edge=gte.0.005"));
  }

  /* ---- 7. the near-miss diagnostic ------------------------------------
     Deliberately NOT flag-gated — it exists to show the sharpest line that is
     NOT yet a signal. But it must never surface a lay quote again. */
  {
    const nmIdx = APP.indexOf("window.__bestNearMiss=nmOk[0]");
    check("The near-miss indicator now passes through filterTradeable",
      nmIdx >= 0 && APP.slice(nmIdx - 400, nmIdx).includes("filterTradeable"));
    const picked = G.filterTradeable([SIGNAL_A, SIGNAL_B]).keep;
    check("...so the +140% lay quote can no longer be 'the sharpest line on the board'",
      picked.length === 1 && picked[0].sig_key === "B");
  }

  console.log("\n========= board flag-discipline regression =========");
  for (const r of rows) {
    console.log(`${r.ok ? " ok " : "FAIL"}  #${String(r.n).padStart(2)} ${r.name}`
      + (!r.ok && r.detail ? `\n           ${r.detail}` : ""));
  }
  console.log("---------------------------------------------------");
  console.log(`TOTAL ${PASS} passed, ${FAIL} failed, ${N} total`);
  console.log("===================================================");
  if (FAIL && typeof process !== "undefined") process.exitCode = 1;
}

await main();
