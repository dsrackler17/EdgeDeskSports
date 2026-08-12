// supabase/tests/capture.write.test.ts
// ============================================================================
// WRITE-PHASE tests for capture, against a recording mock of the PostgREST
// client. No database, no network, no live key.
//
// These exist because the two invariants the whole CLV pipeline rests on are
// invisible to a pricing test:
//
//   1. THE OPENING SNAPSHOT CANNOT DRIFT. Phase A writes first_* once; phase B
//      refreshes the live columns and must never send a first_* column at all.
//      If phase B ever carried one, every capture run would silently reset the
//      opening price of the entire board, and `close` would measure CLV from a
//      price that moved.
//
//   2. THE FLAGGED ENTRY PRICE CANNOT DRIFT. Phase C is the price EdgeDesk put
//      in front of the user; close/index.ts `entryPrice()` treats it as the
//      entry. It must be written under an `is('flagged_at', null)` guard so a
//      later, worse price can never overwrite the one that was offered.
//
// RUN: node --experimental-strip-types --import ./supabase/tests/_deno-shim.mjs \
//        supabase/tests/capture.write.test.ts
// ============================================================================

let PASS = 0, FAIL = 0, N = 0;
const rows: { n: number; name: string; ok: boolean; detail: string }[] = [];
function check(name: string, cond: boolean, detail = "") {
  N++; if (cond) PASS++; else FAIL++;
  rows.push({ n: N, name, ok: cond, detail });
}

process.env.CRON_SECRET = "s";
process.env.ODDS_API_KEY = "k";
process.env.CAPTURE_SPORTS = "baseball_mlb";
process.env.CAPTURE_AUTO_PREFIXES = "";
process.env.CAPTURE_TICKS = "true";
process.env.SUPABASE_URL = "http://localhost";
process.env.SUPABASE_SERVICE_ROLE_KEY = "x";

// ---- recording mock of the supabase-js client -----------------------------
type Op = {
  table: string; kind: "upsert" | "insert" | "update";
  payload: any; opts: any; filters: { fn: string; args: any[] }[];
};
const ops: Op[] = [];
let failOn: ((op: Op) => any) | null = null;

function makeClient() {
  return {
    from(table: string) {
      const mk = (kind: Op["kind"]) => (payload: any, opts: any = {}) => {
        const op: Op = { table, kind, payload, opts, filters: [] };
        ops.push(op);
        const err = failOn?.(op) ?? null;
        const result: any = {
          error: err,
          count: err ? null : (Array.isArray(payload) ? payload.length : 1),
          data: null,
        };
        // thenable so `await` works, plus chainable filter methods
        const chain: any = {
          eq: (...a: any[]) => { op.filters.push({ fn: "eq", args: a }); return chain; },
          is: (...a: any[]) => { op.filters.push({ fn: "is", args: a }); return chain; },
          select: () => chain,
          then: (res: any, rej: any) => Promise.resolve(result).then(res, rej),
        };
        return chain;
      };
      return { upsert: mk("upsert"), insert: mk("insert"), update: mk("update") };
    },
  };
}
(globalThis as any).__MOCK_DB__ = makeClient();

// ---- mock odds feed --------------------------------------------------------
const evt = (id: string, books: [string, number, number][]) => ({
  id, sport_key: "baseball_mlb", sport_title: "MLB",
  commence_time: new Date(Date.now() + 3600e3).toISOString(),
  home_team: "Home", away_team: "Away",
  bookmakers: books.map(([key, a, b]) => ({
    key, title: key,
    markets: [{ key: "h2h", outcomes: [{ name: "Away", price: a }, { name: "Home", price: b }] }],
  })),
});
let oddsBody: any = [];
globalThis.fetch = (async (u: any) => {
  const body = String(u).includes("/sports/?") ? [] : oddsBody;
  return new Response(JSON.stringify(body), {
    status: 200, headers: { "content-type": "application/json", "x-requests-remaining": "9" },
  });
}) as any;

let handler: (req: Request) => Promise<Response>;
(globalThis as any).Deno.serve = (fn: any) => { handler = fn; };

const run = async () => {
  ops.length = 0;
  const res = await handler(new Request("http://x/capture", { headers: { "x-cron-secret": "s" } }));
  return { res, body: await res.json() };
};

const OPENING = ["first_seen_at", "first_best_dec", "first_best_book", "first_sharp_fair", "first_edge", "first_has_sharp"];

async function main() {
  await import("../functions/capture/index.ts");

  /* ================= a normal run ====================================== */
  oddsBody = [evt("e1", [["bookA", 1.90, 1.95], ["bookB", 1.92, 1.93], ["soft", 2.10, 1.80]])];
  const { res, body } = await run();

  check("A run that captured and wrote reports ok", body.ok === true && res.status === 200,
    `${body.ok}/${res.status}`);
  check("...and is labelled a clean run, not a partial one", body.status === "ok", body.status);

  const signalOps = ops.filter((o) => o.table === "signals");
  const phaseA = signalOps.filter((o) => o.kind === "upsert" && o.opts?.ignoreDuplicates === true);
  const phaseB = signalOps.filter((o) => o.kind === "upsert" && o.opts?.ignoreDuplicates === false);
  const phaseC = signalOps.filter((o) => o.kind === "update");
  const tickOps = ops.filter((o) => o.table === "signal_ticks");

  /* ---- PHASE A: the opening snapshot, inserted once ------------------- */
  check("PHASE A runs as an insert-only upsert (ignoreDuplicates)", phaseA.length === 1, `${phaseA.length}`);
  check("PHASE A conflicts on sig_key", phaseA[0]?.opts?.onConflict === "sig_key", phaseA[0]?.opts?.onConflict);
  check("PHASE A carries every opening column",
    OPENING.every((c) => c in phaseA[0].payload[0]),
    OPENING.filter((c) => !(c in (phaseA[0]?.payload?.[0] ?? {}))).join(","));
  check("PHASE A opening price equals the best price seen on this first sighting",
    phaseA[0].payload.every((r: any) => r.first_best_dec === r.best_dec && r.first_edge === r.edge));

  /* ---- PHASE B: THE ONE THAT MUST NOT DRIFT --------------------------- */
  check("PHASE B runs as a merge upsert", phaseB.length === 1, `${phaseB.length}`);
  check("PHASE B sends NO opening column — the snapshot cannot be overwritten",
    phaseB[0].payload.every((r: any) => OPENING.every((c) => !(c in r))),
    JSON.stringify(OPENING.filter((c) => c in (phaseB[0]?.payload?.[0] ?? {}))));
  check("PHASE B still sends the identity columns, so it is a valid row on its own",
    ["sig_key", "event_id", "market", "selection", "commence_time"].every((c) => c in phaseB[0].payload[0]));
  check("PHASE B refreshes the live columns",
    ["best_dec", "best_book", "sharp_fair", "consensus_fair", "edge", "last_seen_at", "n_books"]
      .every((c) => c in phaseB[0].payload[0]));

  /* ---- PHASE C: the frozen entry price -------------------------------- */
  check("PHASE C writes the flagged entry price", phaseC.length >= 1, `${phaseC.length}`);
  check("PHASE C is GUARDED on flagged_at IS NULL, so an entry price cannot drift",
    phaseC.every((o) => o.filters.some((f) => f.fn === "is" && f.args[0] === "flagged_at" && f.args[1] === null)),
    JSON.stringify(phaseC[0]?.filters));
  check("PHASE C targets exactly one sig_key per update",
    phaseC.every((o) => o.filters.some((f) => f.fn === "eq" && f.args[0] === "sig_key")));
  check("PHASE C freezes all four entry columns",
    phaseC.every((o) => ["flagged_at", "flagged_edge", "flagged_best_dec", "flagged_best_book"]
      .every((c) => c in o.payload)));
  check("PHASE C entry price is the price that was flagged, not a later one",
    phaseC.every((o) => o.payload.flagged_best_dec > 1));
  check("PHASE C never sends an opening or live column alongside the freeze",
    phaseC.every((o) => !OPENING.some((c) => c in o.payload) && !("best_dec" in o.payload)));

  /* ---- ticks ---------------------------------------------------------- */
  check("Tick history is written", tickOps.length === 1 && tickOps[0].kind === "insert", `${tickOps.length}`);
  check("Every priced outcome produces a tick",
    tickOps[0].payload.length === body.priced, `${tickOps[0].payload.length} vs ${body.priced}`);
  check("A tick carries the series the replay reads",
    ["sig_key", "best_dec", "sharp_fair", "edge", "n_books"].every((c) => c in tickOps[0].payload[0]));
  check("Ticks are append-only inserts, never upserts",
    tickOps.every((o) => o.kind === "insert"));
  check("ticks_written is reported honestly", body.ticks_written === tickOps[0].payload.length,
    `${body.ticks_written}`);

  /* ================= write failures are never hidden =================== */
  {
    failOn = (op) => (op.table === "signal_ticks"
      ? { message: 'null value in column "created_at" violates not-null constraint', code: "23502" } : null);
    const { body: b } = await run();
    check("A tick write failure is COUNTED, not swallowed", b.tick_write_failures >= 1, `${b.tick_write_failures}`);
    check("...and the database error is surfaced verbatim",
      Array.isArray(b.write_errors) && b.write_errors.some((e: string) => e.includes("created_at")),
      JSON.stringify(b.write_errors));
    check("...and the run is downgraded to partial, not reported clean",
      b.status === "partial", b.status);
    check("...while the signals themselves still committed", b.new_signals > 0, `${b.new_signals}`);
    failOn = null;
  }
  {
    failOn = (op) => (op.kind === "upsert" && op.opts?.ignoreDuplicates === false
      ? { message: 'null value in column "first_edge" violates not-null constraint', code: "23502" } : null);
    const { body: b } = await run();
    check("A phase-B NOT NULL failure on a first_* column is explained, not just echoed",
      (b.write_errors ?? []).some((e: string) => e.includes("NOT NULL") && e.includes("nullable")),
      JSON.stringify(b.write_errors));
    failOn = null;
  }

  /* ================= duplicate sig_key cannot poison a batch =========== */
  {
    // the SAME event id twice in one response — a real duplicate-feed shape
    const dupEvent = evt("dup", [["bookA", 1.90, 1.95], ["bookB", 1.92, 1.93]]);
    oddsBody = [dupEvent, JSON.parse(JSON.stringify(dupEvent))];
    const { body: b } = await run();
    const a = ops.find((o) => o.table === "signals" && o.opts?.ignoreDuplicates === true)!;
    const keys = a.payload.map((r: any) => r.sig_key);
    check("Duplicate feed entries are dropped before the write",
      new Set(keys).size === keys.length, keys.join(","));
    check("...and the drop is reported rather than hidden",
      b.duplicate_sig_keys_dropped === 2, `${b.duplicate_sig_keys_dropped}`);
    oddsBody = [evt("e1", [["bookA", 1.90, 1.95], ["bookB", 1.92, 1.93], ["soft", 2.10, 1.80]])];
  }

  /* ================= a run that captured nothing is not a success ====== */
  {
    oddsBody = [];
    const { res: r2, body: b } = await run();
    check("A run that priced nothing reports ok:false", b.ok === false, `${b.ok}`);
    check("...with HTTP 500 so a caller that checks status sees it", r2.status === 500, `${r2.status}`);
    check("...and is labelled failed", b.status === "failed", b.status);
    check("...and writes nothing", ops.filter((o) => o.table === "signals").length === 0);
  }

  console.log("\n============= capture write-phase tests =============");
  for (const r of rows) {
    console.log(`${r.ok ? " ok " : "FAIL"}  #${String(r.n).padStart(2)} ${r.name}`
      + (!r.ok && r.detail ? `\n           ${r.detail}` : ""));
  }
  console.log("-----------------------------------------------------");
  console.log(`TOTAL ${PASS} passed, ${FAIL} failed, ${N} total`);
  console.log("=====================================================");
  if (FAIL && typeof process !== "undefined") process.exitCode = 1;
}

await main();
