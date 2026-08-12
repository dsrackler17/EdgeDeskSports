// supabase/tests/capture.test.ts
// ============================================================================
// Tests for the capture function's PRICING and FLAG DISCIPLINE.
//
// Outside the function folder for the same reason the research suite is: the
// dashboard bundles the deployed function's folder, and single-file deployment
// discipline must not be threatened by a test file.
//
// These test the pure logic — devig, priceEvent, flaggable, sigKey. The write
// phases need a database and are covered by the function's own ?diag=1 mode,
// which prices a sport and writes nothing.
//
// RUN (Node): node --experimental-strip-types supabase/tests/capture.test.ts
// ============================================================================

(globalThis as any).Deno = (globalThis as any).Deno ?? {};
(globalThis as any).Deno.env = { get: (_k: string) => undefined };
(globalThis as any).Deno.serve = () => {};

let PASS = 0, FAIL = 0;
const rows: { n: number; name: string; ok: boolean; detail: string }[] = [];
let N = 0;
function check(name: string, cond: boolean, detail = "") {
  N++; if (cond) PASS++; else FAIL++;
  rows.push({ n: N, name, ok: cond, detail });
}

const ev = (id: string, books: [string, number, number][]) => ({
  id, sport_key: "baseball_mlb", sport_title: "MLB", commence_time: new Date().toISOString(),
  home_team: "Home", away_team: "Away",
  bookmakers: books.map(([key, a, b]) => ({
    key, title: key,
    markets: [{ key: "h2h", outcomes: [{ name: "Away", price: a }, { name: "Home", price: b }] }],
  })),
});

async function main() {
  const C: any = await import("../functions/capture/index.ts");

  /* ---- 1. THE BUG THAT BROKE THE BOARD -------------------------------- */
  {
    const priced = C.priceEvent(ev("e1", [
      ["bookA", 1.90, 1.95], ["bookB", 1.92, 1.93], ["bookC", 1.88, 1.98],
      ["stalefeed", 12.0, 1.05],
    ]), "shin", "pinnacle");
    const away = priced.find((o: any) => o.selection === "Away");
    check("A stale outlier quote still produces a huge raw edge (the input is unchanged)",
      away.edge > 3, `edge=${away?.edge?.toFixed(2)}`);
    const v = C.flaggable(away);
    check("...but it is REFUSED as an outlier and never flagged",
      v.ok === false && v.reason === "best_price_is_an_outlier_vs_the_other_books",
      `${v.ok}/${v.reason}`);
    check("...and median_dec is carried so the refusal can be checked",
      Math.abs(away.median_dec - 1.91) < 0.05, `median_dec=${away.median_dec}`);
  }

  /* ---- 2. a genuinely soft price still flags --------------------------- */
  {
    const priced = C.priceEvent(ev("e2", [
      ["bookA", 1.90, 1.95], ["bookB", 1.92, 1.93], ["softbook", 2.10, 1.80],
    ]), "shin", "pinnacle");
    const away = priced.find((o: any) => o.selection === "Away");
    const v = C.flaggable(away);
    check("A genuinely soft book is still flagged — the filter is not a blanket ban",
      v.ok === true && away.edge > 0, `edge=${away.edge.toFixed(4)} ok=${v.ok} reason=${v.reason}`);
  }

  /* ---- 3. every other bound ------------------------------------------- */
  {
    const base = { market: "h2h", edge: 0.05, best_dec: 1.9, median_dec: 1.85, n_books: 5 };
    check("Exchange lay markets are refused",
      C.flaggable({ ...base, market: "h2h_lay" }).reason === "exchange_lay_not_backable");
    check("A price above the tradeable bound is refused",
      C.flaggable({ ...base, best_dec: 45, median_dec: 44 }).reason === "price_above_tradeable_bound");
    check("A single-book fair is refused as not a consensus",
      C.flaggable({ ...base, n_books: 1 }).reason === "single_book_fair_is_not_a_consensus");
    check("An implausible edge is refused as a bad price",
      C.flaggable({ ...base, edge: 0.9, median_dec: 1.89 }).reason === "edge_implausible_bad_price");
    check("A sub-floor edge is refused quietly as the ordinary case",
      C.flaggable({ ...base, edge: 0.001 }).reason === "below_flag_floor");
    check("A normal, corroborated, in-band price is accepted",
      C.flaggable(base).ok === true, JSON.stringify(C.flaggable(base)));
  }

  /* ---- 4. sigKey must not drift --------------------------------------- */
  {
    check("sigKey keeps the trailing pipe for a null point",
      C.sigKey({ event_id: "e", market: "h2h", selection: "Team", point: null }) === "e|h2h|Team|");
    check("sigKey carries the point when there is one",
      C.sigKey({ event_id: "e", market: "spreads", selection: "Team", point: -1.5 }) === "e|spreads|Team|-1.5");
  }

  /* ---- 5. devig still sums to one ------------------------------------- */
  {
    const f = C.devig([1.90, 1.95], "shin");
    check("Shin devig produces probabilities summing to 1",
      Math.abs(f.reduce((a: number, b: number) => a + b, 0) - 1) < 1e-6, `${f}`);
    check("Devigged fair values are inside (0,1)",
      f.every((x: number) => x > 0 && x < 1), `${f}`);
  }

  /* ---- 6. no duplicate outcome keys within one event ------------------- */
  {
    const priced = C.priceEvent(ev("e3", [["a", 1.9, 1.95], ["b", 1.91, 1.94]]), "shin", "pinnacle");
    const keys = priced.map((o: any) => C.sigKey(o));
    check("priceEvent emits one row per selection, never a duplicate sig_key",
      new Set(keys).size === keys.length && keys.length === 2, keys.join(","));
  }

  console.log("\n=============== capture flag-discipline tests ===============");
  for (const r of rows) {
    console.log(`${r.ok ? " ok " : "FAIL"}  #${String(r.n).padStart(2)} ${r.name}`
      + (!r.ok && r.detail ? `\n           ${r.detail}` : ""));
  }
  console.log("------------------------------------------------------------");
  console.log(`TOTAL ${PASS} passed, ${FAIL} failed, ${N} total`);
  console.log("============================================================");
  if (FAIL && typeof process !== "undefined") process.exitCode = 1;
}

await main();
