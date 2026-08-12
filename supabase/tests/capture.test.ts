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

  /* ---- 7. THE RUN-KILLER: a market with no `outcomes` ------------------
     `bookmakers` and `markets` were guarded; `outcomes` was not. priceEvent is
     called inside the sport loop with nothing to catch it, so this TypeError
     unwound out of the request handler and lost EVERY sport — while the
     fire-and-forget cron caller still recorded a successful run. */
  {
    const malformed = (mk: any) => ({
      id: "bad", sport_key: "baseball_mlb", sport_title: "MLB",
      commence_time: new Date().toISOString(), home_team: "H", away_team: "A",
      bookmakers: [{ key: "b", title: "B", markets: [mk] }],
    });
    let threw = "";
    try { C.priceEvent(malformed({ key: "h2h" }), "shin", "pinnacle"); }
    catch (e) { threw = (e as Error).message; }
    check("A market with NO outcomes array does not throw out of priceEvent", threw === "", threw);

    threw = "";
    try { C.priceEvent(malformed({ key: "h2h", outcomes: null }), "shin", "pinnacle"); }
    catch (e) { threw = (e as Error).message; }
    check("A market with outcomes:null does not throw either", threw === "", threw);

    check("A malformed market is skipped, not priced",
      C.priceEvent(malformed({ key: "h2h" }), "shin", "pinnacle").length === 0);
  }

  /* ---- 8. one malformed market must not cost the GOOD markets ---------- */
  {
    const mixed = {
      id: "mix", sport_key: "baseball_mlb", sport_title: "MLB",
      commence_time: new Date().toISOString(), home_team: "H", away_team: "A",
      bookmakers: [
        { key: "broken", title: "Broken", markets: [{ key: "h2h" }] },
        { key: "bookA", title: "A", markets: [{ key: "h2h", outcomes: [{ name: "Away", price: 1.90 }, { name: "Home", price: 1.95 }] }] },
        { key: "bookB", title: "B", markets: [{ key: "h2h", outcomes: [{ name: "Away", price: 1.92 }, { name: "Home", price: 1.93 }] }] },
      ],
    };
    const priced = C.priceEvent(mixed, "shin", "pinnacle");
    check("A broken book alongside good books still prices the good ones",
      priced.length === 2, `priced=${priced.length}`);
    check("...and the broken book is not counted as a corroborating book",
      priced.every((o: any) => o.n_books === 2), priced.map((o: any) => o.n_books).join(","));
  }

  /* ---- 9. non-numeric / null prices ------------------------------------ */
  {
    const weird = (a: any, b: any) => ({
      id: "w", sport_key: "s", sport_title: "S", commence_time: new Date().toISOString(),
      home_team: "H", away_team: "A",
      bookmakers: [{ key: "b", title: "B", markets: [{ key: "h2h", outcomes: [{ name: "Away", price: a }, { name: "Home", price: b }] }] }],
    });
    check("A null price is rejected, not devigged",
      C.priceEvent(weird(null, 1.9), "shin", "pinnacle").length === 0);
    check("A non-numeric price is rejected, not coerced into a fair line",
      C.priceEvent(weird("abc", 1.9), "shin", "pinnacle").length === 0);
    check("A price of exactly 1.0 is rejected",
      C.priceEvent(weird(1.0, 1.9), "shin", "pinnacle").length === 0);
  }

  /* ---- 10. THE CONSENSUS GATE: n_books counts BOOKS, not QUOTES --------
     A single feed listing the same outcome twice used to report n_books:2 and
     satisfy MIN_BOOKS_TO_FLAG — defeating the exact check meant to stop a
     one-book fair from being flagged as a consensus. */
  {
    const dup = {
      id: "dup", sport_key: "s", sport_title: "S", commence_time: new Date().toISOString(),
      home_team: "H", away_team: "A",
      bookmakers: [{
        key: "solo", title: "Solo",
        markets: [{ key: "h2h", outcomes: [
          { name: "Away", price: 2.10 }, { name: "Home", price: 1.80 }, { name: "Away", price: 2.10 },
        ] }],
      }],
    };
    const away = C.priceEvent(dup, "shin", "pinnacle").find((o: any) => o.selection === "Away");
    check("A book quoting the same selection twice counts as ONE book",
      away.n_books === 1, `n_books=${away.n_books}`);
    check("...so the duplicate can no longer pass the consensus gate",
      C.flaggable({ ...away, edge: 0.05 }).reason === "single_book_fair_is_not_a_consensus",
      JSON.stringify(C.flaggable({ ...away, edge: 0.05 })));
  }

  /* ---- 11. two real books still corroborate normally ------------------- */
  {
    const priced = C.priceEvent(ev("ok2", [["bookA", 1.90, 1.95], ["bookB", 1.92, 1.93]]), "shin", "pinnacle");
    const away = priced.find((o: any) => o.selection === "Away");
    check("Two genuinely distinct books still report n_books=2",
      away.n_books === 2, `n_books=${away.n_books}`);
    check("best_dec is the highest of the deduped quotes",
      away.best_dec === 1.92, `best_dec=${away.best_dec}`);
    check("median_dec is drawn from the same population as best_dec",
      Math.abs(away.median_dec - 1.91) < 1e-9, `median_dec=${away.median_dec}`);
  }

  /* ---- 12. the v5 outlier behaviour is unchanged (regression) ---------- */
  {
    const priced = C.priceEvent(ev("reg", [
      ["bookA", 1.90, 1.95], ["bookB", 1.92, 1.93], ["bookC", 1.88, 1.98], ["stalefeed", 12.0, 1.05],
    ]), "shin", "pinnacle");
    const away = priced.find((o: any) => o.selection === "Away");
    check("REGRESSION: the stale 12.0 quote is still refused as an outlier",
      C.flaggable(away).reason === "best_price_is_an_outlier_vs_the_other_books");
    check("REGRESSION: four books still report n_books=4",
      away.n_books === 4, `n_books=${away.n_books}`);
    check("REGRESSION: backable() still rejects lay markets",
      C.backable("h2h_lay") === false && C.backable("h2h") === true);
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
